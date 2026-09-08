from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_ROOT = ROOT / "reference-reports"
OUT = REPORT_ROOT / "index.json"

LABELS = {
    "mid-season-recap": "Mid-Season Recap",
    "regular-season-recap": "Regular Season Recap",
    "season-recap": "Season Recap",
    "championship-week": "Championship Recap",
    "championship-recap": "Championship Recap",
    "champion-recap": "Champion Recap",
    "playoff-recap": "Playoff Recap",
    "postseason-recap": "Postseason Recap",
    "season-awards": "Season Awards",
    "draft-recap": "Draft Recap",
}


def meaningful(text: str) -> bool:
    text = re.sub(r"\[?Source\s+Missing\]?", "", text, flags=re.I)
    text = re.sub(r"^\s*[#>*_-]+\s*$", "", text, flags=re.M)
    return len(text.strip()) >= 20


def pretty_label(stem: str) -> str:
    if stem in LABELS:
        return LABELS[stem]
    return " ".join(part.upper() if part.lower() in {"mvp", "nfl"} else part.capitalize()
                    for part in stem.replace("_", "-").split("-") if part)


def main() -> None:
    years: dict[str, list[dict]] = {}
    if not REPORT_ROOT.exists():
        REPORT_ROOT.mkdir(parents=True, exist_ok=True)

    for year_dir in sorted(REPORT_ROOT.iterdir() if REPORT_ROOT.exists() else []):
        if not year_dir.is_dir() or not re.fullmatch(r"\d{4}", year_dir.name):
            continue
        entries = []
        for path in sorted(year_dir.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                text = path.read_text(encoding="utf-8", errors="replace")
            if not meaningful(text):
                continue
            rel = path.relative_to(ROOT).as_posix()
            m = re.fullmatch(r"week(\d{1,2})", path.stem, flags=re.I)
            if m:
                entries.append({"type": "week", "week": int(m.group(1)), "path": rel})
            else:
                entries.append({
                    "type": "special",
                    "slug": path.stem,
                    "label": pretty_label(path.stem),
                    "path": rel,
                })
        if entries:
            entries.sort(key=lambda e: (0, e["week"]) if e["type"] == "week" else (1, e["label"].lower()))
            years[year_dir.name] = entries

    OUT.write_text(json.dumps({"years": years}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT} ({sum(len(v) for v in years.values())} entries)")


if __name__ == "__main__":
    main()
