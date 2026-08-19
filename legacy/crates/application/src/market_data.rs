use chrono::{DateTime, Duration, Utc};
use fin_alfred_domain::{DataOrigin, MarketQuoteSnapshot};
use reqwest::blocking::Client;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::time::Duration as StdDuration;
use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketProviderConfig {
    pub quote_url: String,
    pub source_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderQuote {
    pub price: String,
    pub currency: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum MarketDataError {
    #[error("market provider URL must be HTTPS without credentials, query, or fragment")]
    InvalidUrl,
    #[error("market provider request failed")]
    Request,
    #[error("market provider returned invalid quote data")]
    InvalidQuote,
}

pub trait MarketDataProvider: Send + Sync {
    fn fetch_quote(&self, api_key: Option<&str>) -> Result<ProviderQuote, MarketDataError>;
    fn source_label(&self) -> &str;
}

pub struct JsonHttpMarketDataProvider {
    config: MarketProviderConfig,
    client: Client,
}

impl JsonHttpMarketDataProvider {
    pub fn new(config: MarketProviderConfig) -> Result<Self, MarketDataError> {
        validate_provider_url(&config.quote_url)?;
        if config.source_label.trim().is_empty() {
            return Err(MarketDataError::InvalidQuote);
        }
        let client = Client::builder()
            .timeout(StdDuration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MarketDataError::Request)?;
        Ok(Self { config, client })
    }
}

impl MarketDataProvider for JsonHttpMarketDataProvider {
    fn fetch_quote(&self, api_key: Option<&str>) -> Result<ProviderQuote, MarketDataError> {
        let mut request = self.client.get(&self.config.quote_url);
        if let Some(api_key) = api_key.filter(|value| !value.is_empty()) {
            request = request.bearer_auth(api_key);
        }
        request
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|_| MarketDataError::Request)?
            .json()
            .map_err(|_| MarketDataError::InvalidQuote)
    }

    fn source_label(&self) -> &str {
        &self.config.source_label
    }
}

pub fn quote_snapshot<P: MarketDataProvider>(
    provider: &P,
    api_key: Option<Zeroizing<String>>,
    profile_id: &str,
    instrument_id: &str,
) -> Result<MarketQuoteSnapshot, MarketDataError> {
    let quote = provider.fetch_quote(api_key.as_deref().map(String::as_str))?;
    let price = Decimal::from_str(&quote.price).map_err(|_| MarketDataError::InvalidQuote)?;
    if price <= Decimal::ZERO
        || quote.currency != "HKD"
        || quote.observed_at > Utc::now() + Duration::minutes(5)
    {
        return Err(MarketDataError::InvalidQuote);
    }
    Ok(MarketQuoteSnapshot {
        profile_id: profile_id.into(),
        instrument_id: instrument_id.into(),
        price,
        currency: quote.currency,
        observed_at: quote.observed_at,
        valid_until: quote.observed_at + Duration::hours(24),
        origin: DataOrigin::Provider,
        source_label: provider.source_label().into(),
    })
}

fn validate_provider_url(value: &str) -> Result<(), MarketDataError> {
    let parsed = reqwest::Url::parse(value).map_err(|_| MarketDataError::InvalidUrl)?;
    let loopback_http = parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if (parsed.scheme() != "https" && !loopback_http)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(MarketDataError::InvalidUrl);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    struct FixtureProvider(ProviderQuote);
    impl MarketDataProvider for FixtureProvider {
        fn fetch_quote(&self, _api_key: Option<&str>) -> Result<ProviderQuote, MarketDataError> {
            Ok(self.0.clone())
        }
        fn source_label(&self) -> &str {
            "contract fixture"
        }
    }

    #[test]
    fn provider_quote_becomes_a_scoped_expiring_snapshot() {
        let observed_at = Utc::now() - Duration::minutes(1);
        let snapshot = quote_snapshot(
            &FixtureProvider(ProviderQuote {
                price: "25.62".into(),
                currency: "HKD".into(),
                observed_at,
            }),
            None,
            "profile-a",
            "HKEX:1810",
        )
        .unwrap();
        assert_eq!(snapshot.profile_id, "profile-a");
        assert_eq!(snapshot.origin, DataOrigin::Provider);
        assert_eq!(snapshot.valid_until, observed_at + Duration::hours(24));
    }

    #[test]
    fn unsafe_urls_and_wrong_currency_are_rejected() {
        assert!(JsonHttpMarketDataProvider::new(MarketProviderConfig {
            quote_url: "http://example.com/quote".into(),
            source_label: "unsafe".into()
        })
        .is_err());
        assert!(JsonHttpMarketDataProvider::new(MarketProviderConfig {
            quote_url: "https://user:pass@example.com/quote".into(),
            source_label: "unsafe".into()
        })
        .is_err());
        let result = quote_snapshot(
            &FixtureProvider(ProviderQuote {
                price: "25.62".into(),
                currency: "USD".into(),
                observed_at: Utc::now(),
            }),
            None,
            "p",
            "HKEX:1810",
        );
        assert!(matches!(result, Err(MarketDataError::InvalidQuote)));
    }

    #[test]
    fn http_contract_sends_bearer_and_parses_the_documented_json_shape() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0_u8; 4096];
            let count = stream.read(&mut bytes).unwrap();
            sender
                .send(String::from_utf8_lossy(&bytes[..count]).into_owned())
                .unwrap();
            let body = format!(
                r#"{{"price":"25.62","currency":"HKD","observed_at":"{}"}}"#,
                Utc::now().to_rfc3339()
            );
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let provider = JsonHttpMarketDataProvider::new(MarketProviderConfig {
            quote_url: format!("http://{address}/quote"),
            source_label: "local contract".into(),
        })
        .unwrap();
        let quote = provider.fetch_quote(Some("provider-secret")).unwrap();
        assert_eq!(quote.price, "25.62");
        let request = receiver.recv().unwrap().to_ascii_lowercase();
        assert!(request.contains("authorization: bearer provider-secret"));
    }
}
