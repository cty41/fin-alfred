use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentPermission {
    Read,
    Analyze,
    CreateDraft,
    MutateFormalState,
    TradeRelated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentPolicy {
    pub granted: Vec<AgentPermission>,
}

impl Default for AgentPolicy {
    fn default() -> Self {
        Self {
            granted: vec![
                AgentPermission::Read,
                AgentPermission::Analyze,
                AgentPermission::CreateDraft,
            ],
        }
    }
}

impl AgentPolicy {
    pub fn authorize(&self, requested: AgentPermission) -> bool {
        self.granted.contains(&requested)
            && !matches!(
                requested,
                AgentPermission::MutateFormalState | AgentPermission::TradeRelated
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_agent_can_only_read_analyze_and_draft() {
        let policy = AgentPolicy::default();
        assert!(policy.authorize(AgentPermission::Read));
        assert!(policy.authorize(AgentPermission::CreateDraft));
        assert!(!policy.authorize(AgentPermission::MutateFormalState));
        assert!(!policy.authorize(AgentPermission::TradeRelated));
    }
}
