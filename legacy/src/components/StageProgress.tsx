import { Check, LockKeyhole, TimerReset } from "lucide-react";
import type { StrategyStage } from "../domain/types";

function StageIcon({ status }: { status: StrategyStage["status"] }) {
  if (status === "completed") return <Check aria-hidden="true" />;
  if (status === "waiting") return <TimerReset aria-hidden="true" />;
  return <LockKeyhole aria-hidden="true" />;
}

export function StageProgress({ stages }: { stages: StrategyStage[] }) {
  return (
    <section className="side-section">
      <header className="section-heading">
        <div>
          <p className="eyebrow">225,600股基准</p>
          <h3>四阶段风险迁移</h3>
        </div>
      </header>
      <ol className="stage-list">
        {stages.map((stage) => (
          <li className={`stage ${stage.status}`} key={stage.stage}>
            <div className="stage-icon"><StageIcon status={stage.status} /></div>
            <div>
              <div className="stage-title"><strong>Stage {stage.stage}</strong><span>{stage.label}</span></div>
              <p>{stage.nextRequirement}</p>
              <small>累计目标 {Number(stage.cumulativeTargetQuantity).toLocaleString()}股 · 已卖 {Number(stage.actualCumulativeQuantity).toLocaleString()}股</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
