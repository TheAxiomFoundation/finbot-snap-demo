/**
 * Compact "thinking" pill — three CSS-animated dots after a small mono
 * label. Shared between the chat surface (where it indicates the request
 * is in flight before any assistant content arrives) and the assistant
 * turn (where it bridges the gap between tool-call rounds completing and
 * the final text starting to stream).
 */
export function RunningPill({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: "#fafaf6",
        border: "1px solid #e6e6df",
        borderRadius: 999,
        alignSelf: "flex-start",
        color: "#6b7280",
      }}
    >
      <span className="mono" style={{ fontSize: 11.5 }}>{label}</span>
      <span className="thinking-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
    </div>
  );
}
