import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

async function openXiaomi() {
  fireEvent.click(await screen.findByRole("button", { name: "小 小米集团-W 01810" }));
  expect(await screen.findByRole("button", { name: "Summary" })).toBeInTheDocument();
}

describe("Alpha Spread style prototype", () => {
  it("uses Watchlist as the only prototype entry point", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Watchlist" })).toBeInTheDocument();
    for (const heading of ["Company", "Price Graph", "Last Price", "Buy Price", "Intrinsic Value", "Relative Value"]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }
    expect(await screen.findByRole("button", { name: "小 小米集团-W 01810" })).toBeInTheDocument();
    expect(screen.queryByText("AI 对话")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "决策" })).not.toBeInTheDocument();
  });

  it("keeps the real Xiaomi ledger state read-only on Summary", async () => {
    render(<App />);
    await openXiaomi();
    expect(screen.getByText("213,600 股")).toBeInTheDocument();
    expect(screen.getByText("HK$395,000")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText(/不提供交易操作/)).toBeInTheDocument();
  });

  it("exposes only the four individual-company analysis tabs", async () => {
    render(<App />);
    await openXiaomi();
    for (const tab of ["Summary", "Financials", "DCF Valuation", "Relative Valuation"]) {
      expect(screen.getByRole("button", { name: tab })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /李录/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Burry/ })).not.toBeInTheDocument();
  });

  it("keeps valuation inputs inside calculation dialogs", async () => {
    render(<App />);
    await openXiaomi();
    fireEvent.click(screen.getByRole("button", { name: "DCF Valuation" }));
    fireEvent.click(screen.getByRole("button", { name: "View Calculation" }));
    expect(screen.getByRole("dialog", { name: /DCF Model/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Starting Revenue")).toBeInTheDocument();
  });

  it("identifies intentionally hidden first-version functions in Settings", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Watchlist" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByText("AI、MCP、交易和策略功能在此原型中已隐藏。")).toBeInTheDocument();
  });

  it("opens the development diagnostics viewer from Settings", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Watchlist" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "打开开发诊断" }));
    expect(await screen.findByRole("dialog", { name: "开发诊断" })).toBeInTheDocument();
    expect(await screen.findByText("refresh_watchlist_prices")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出诊断包/ })).toBeInTheDocument();
    expect(screen.getByLabelText("搜索日志")).toBeInTheDocument();
  });
});
