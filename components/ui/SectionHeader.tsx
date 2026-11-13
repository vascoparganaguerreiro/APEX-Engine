/** Title row for a page section: an optional small eyebrow, a real heading, and an optional action on the right. */
export default function SectionHeader({ title, eyebrow, action, level = 2, id }: { title: string; eyebrow?: string; action?: React.ReactNode; level?: 2 | 3; id?: string }) {
  const H = `h${level}` as "h2" | "h3";
  return (
    <div className="ds-section-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <H id={id}>{title}</H>
      </div>
      {action && <div className="ds-section-action">{action}</div>}
    </div>
  );
}
