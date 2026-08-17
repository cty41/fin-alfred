import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("research workbench", () => {
  it("shows the real Xiaomi stage-one completion without presenting a trade action", async () => {
    render(<App />);
    expect(await screen.findByText("213,600股")).toBeInTheDocument();
    expect(screen.getByText("已由真实成交完成，禁止重复建议")).toBeInTheDocument();
    expect(screen.queryByText("执行交易")).not.toBeInTheDocument();
  });

  it("creates a draft artifact but never publishes it", async () => {
    render(<App />);
    const input = await screen.findByLabelText("向研究助手提问");
    fireEvent.change(input, { target: { value: "为Stage 2生成策略草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("region", { name: "发送内容预览" })).toBeInTheDocument();
    expect(screen.getByText(/排除：API密钥/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    expect(await screen.findByText("小米 Stage 2 反弹减仓检查表")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("策略草稿 · 未发布")).toBeInTheDocument());
    expect(screen.queryByText("发布策略")).not.toBeInTheDocument();
  });

  it("does not accept BYOK secrets in browser preview mode", async () => {
    render(<App />);
    await screen.findByText("213,600股");
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存BYOK配置" })).toBeDisabled();
  });

  it("creates and switches to an isolated family profile", async () => {
    render(<App />);
    await screen.findByText("213,600股");
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建档案" }));
    fireEvent.change(screen.getByLabelText("新档案名称"), { target: { value: "家人投资档案" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect((await screen.findAllByText("先录入并核验该档案的初始持仓")).length).toBe(4);
    expect((screen.getByLabelText("切换投资档案") as HTMLSelectElement).value).toMatch(/^profile-/);
    fireEvent.change(screen.getByLabelText("切换投资档案"), { target: { value: "profile-xiaomi-real" } });
    expect(await screen.findByText("213,600股")).toBeInTheDocument();
    expect(screen.getByText("已由真实成交完成，禁止重复建议")).toBeInTheDocument();
  });

  it("switches the internationalized application shell to English", async () => {
    render(<App />);
    await screen.findByText("213,600股");
    fireEvent.click(screen.getByLabelText("切换语言"));
    expect(screen.getByRole("button", { name: /Portfolio/ })).toBeInTheDocument();
    expect(screen.getByText("Browser demo mode")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });
});
