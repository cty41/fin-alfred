/* eslint-disable react-refresh/only-export-components */
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh-CN" | "en";
type MessageKey = keyof typeof messages["zh-CN"];

const messages = {
  "zh-CN": {
    research: "研究", portfolio: "组合", decisions: "决策", ledger: "账本", audit: "审计", settings: "设置",
    profile: "投资档案", newProfile: "＋ 新建档案", cancel: "取消", create: "创建", assistant: "研究助手",
    browserMode: "浏览器示例模式", encryptedMode: "本地加密档案", opening: "正在打开投资档案…",
    watchlist: "关注标的", needsReview: "需要复核", language: "中文", currentPosition: "当前持股", cash: "现金", completedReduction: "已完成减仓",
  },
  en: {
    research: "Research", portfolio: "Portfolio", decisions: "Decisions", ledger: "Ledger", audit: "Audit", settings: "Settings",
    profile: "Investment profile", newProfile: "+ New profile", cancel: "Cancel", create: "Create", assistant: "Research assistant",
    browserMode: "Browser demo mode", encryptedMode: "Local encrypted profile", opening: "Opening investment profile…",
    watchlist: "Watchlist", needsReview: "Needs review", language: "English", currentPosition: "Current position", cash: "Cash", completedReduction: "Reduction completed",
  },
} as const;

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (key: MessageKey) => string }
const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem("margin-safety.locale") === "en" ? "en" : "zh-CN");
  useEffect(() => { localStorage.setItem("margin-safety.locale", locale); document.documentElement.lang = locale; }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t: (key: MessageKey) => messages[locale][key] }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("I18nProvider is missing");
  return value;
}
