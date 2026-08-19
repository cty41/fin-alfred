import type { QualityDimension } from "../domain/types";

const freshnessLabel = { fresh: "证据新鲜", aging: "待复核", missing: "缺少证据" };

export function QualityTrack({ title, weight, dimensions }: { title: string; weight: string; dimensions: QualityDimension[] }) {
  return (
    <section className="quality-track" aria-label={title}>
      <header className="section-heading">
        <div>
          <p className="eyebrow">{weight}</p>
          <h3>{title}</h3>
        </div>
        <span className="status neutral">尚未发布评分</span>
      </header>
      <div className="dimension-list">
        {dimensions.map((dimension) => (
          <button className="dimension-row" type="button" key={dimension.id}>
            <span>{dimension.label}</span>
            <span className={`freshness ${dimension.evidenceFreshness}`}>{freshnessLabel[dimension.evidenceFreshness]}</span>
            <strong>{dimension.score ?? "—"}<small>/4</small></strong>
          </button>
        ))}
      </div>
    </section>
  );
}
