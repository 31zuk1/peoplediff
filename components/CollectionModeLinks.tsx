export default function CollectionModeLinks({ mode }: { mode: "broad" | "jp-major" }) {
  return (
    <nav aria-label="収集対象" className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
      <span>収集対象</span>
      <a href="/?mode=broad" aria-current={mode === "broad" ? "page" : undefined} className={mode === "broad" ? "font-semibold text-cyan-200" : "hover:text-white"}>各言語版の全体比較</a>
      <span aria-hidden="true">/</span>
      <a href="/?mode=jp-major" aria-current={mode === "jp-major" ? "page" : undefined} className={mode === "jp-major" ? "font-semibold text-cyan-200" : "hover:text-white"}>日本語「人民日報の主要ニュース」</a>
    </nav>
  );
}
