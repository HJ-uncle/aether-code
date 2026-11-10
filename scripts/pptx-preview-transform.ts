/** Targeted fixes for the pinned converter, applied to both Work and Code by
 * Vite. Fail on source drift instead of silently shipping an unpatched view. */
export function patchPptxPreview(source: string): string {
  let output = source
  const replace = (before: string, after: string, count = 1): void => {
    if (output.split(before).length - 1 !== count) throw new Error('PPTX preview patch no longer matches @jvmr/pptx-to-html 1.1.2; review its chart/image/table renderer before upgrading.')
    output = output.split(before).join(after)
  }
  replace('var ChartExtractor = class {', `
// Font sizes in DrawingML are hundredths of a point; SVG user units here are
// 96 dpi pixels before the entire source slide is scaled to the preview size.
function aetherChartFontSizes(doc) {
  const first = (root, name) => root?.getElementsByTagNameNS("*", name)[0];
  const direct = (root, name) => Array.from(root?.childNodes || []).find(node => node.localName === name);
  const inherited = direct(doc.documentElement, "txPr");
  const size = root => {
    const properties = direct(root, "txPr") || inherited;
    const raw = Number((first(properties, "defRPr") || first(properties, "rPr"))?.getAttribute("sz"));
    return Number.isFinite(raw) && raw > 0 && raw <= 19200 ? raw / 75 : undefined;
  };
  return { category: size(first(doc, "catAx") || first(doc, "dateAx")), value: size(first(doc, "valAx")),
    legend: size(first(doc, "legend")), data: size(first(doc, "dLbls")) };
}
function aetherChartFont(el, kind, fallback) { return el.fontSizes?.[kind] || fallback; }
function aetherChartShowsLabels(plotArea) {
  return Array.from(plotArea.getElementsByTagNameNS("*", "dLbls")).some(labels =>
    ["showVal", "showCatName", "showSerName", "showPercent", "showBubbleSize"].some(name =>
      Array.from(labels.getElementsByTagNameNS("*", name)).some(node => ["1", "true", "on"].includes(node.getAttribute("val")))));
}
var ChartExtractor = class {`)
  replace('showLegend: parsed.showLegend,', 'showLegend: parsed.showLegend,\n\t\t\t\tfontSizes: aetherChartFontSizes(doc),')
  replace('const showDataLabels = !!plotArea.getElementsByTagNameNS("*", "dLbls")[0];', 'const showDataLabels = aetherChartShowsLabels(plotArea);')
  // The upstream renderer hardcodes 10px for axis/data/legend text, ignoring
  // OOXML settings. Limit replacements to its chart region, never text boxes.
  const start = output.indexOf('//#region src/renderer/renderChartElement.ts')
  const end = output.indexOf('//#region src/renderer/HtmlRenderer.ts')
  if (start < 0 || end <= start) throw new Error('PPTX chart renderer boundaries changed')
  let chart = output.slice(start, end)
  const chartReplace = (before: string, after: string, count: number): void => {
    if (chart.split(before).length - 1 !== count) throw new Error('PPTX chart text patch no longer matches the pinned converter')
    chart = chart.split(before).join(after)
  }
  chartReplace('const padding = 24;', 'const padding = Math.max(24, aetherChartFont(el, "value", 10) * 3, aetherChartFont(el, "category", 12) * 2);', 1)
  chartReplace('font-size="10" fill="#666"', 'data-pptx-chart-label="value" font-size="${aetherChartFont(el, "value", 10)}" fill="#666"', 5)
  chartReplace('font-size="10" fill="#000"', 'data-pptx-chart-label="data" font-size="${aetherChartFont(el, "data", 10)}" fill="#000"', 7)
  chartReplace('font-size="10" fill="#333"', 'data-pptx-chart-label="legend" font-size="${aetherChartFont(el, "legend", 10)}" fill="#333"', 1)
  chartReplace('font-size="${labelSize}" fill="#333"', 'data-pptx-chart-label="category" font-size="${labelSize}" fill="#333"', 3)
  chartReplace('<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">', '<svg data-pptx-chart="${el.chartType}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">', 1)
  chartReplace('const labelSize = Math.max(10, Math.min(12, chartH / (catCount * 2)));', 'const labelSize = aetherChartFont(el, "category", Math.max(10, Math.min(12, chartH / (catCount * 2))));', 1)
  chartReplace('const labelSize = Math.max(10, Math.min(12, chartW / (catCount * 4)));', 'const labelSize = aetherChartFont(el, "category", Math.max(10, Math.min(12, chartW / (catCount * 4))));', 2)
  chartReplace('x += 14 + label.length * 6 + 10;', 'x += 14 + Array.from(label).reduce((width, character) => width + (character.codePointAt(0) > 255 ? 1 : 0.6), 0) * aetherChartFont(el, "legend", 10) + 10;', 1)
  chartReplace('return parts.join("\\n");\n}\nfunction renderArea', 'if (el.showLegend) parts.push(renderLegend(el, width, pad, palette));\n\treturn parts.join("\\n");\n}\nfunction renderArea', 1)
  // A center-anchored label puts half its text back over the slice. Anchor
  // sideways labels away from the circle; top/bottom labels clear it in y.
  chartReplace('const lx = cx + (r + 12) * Math.cos(mid);\n\t\t\tconst ly = cy + (r + 12) * Math.sin(mid);',
    'const labelGap = aetherChartFont(el, "data", 10) + 6;\n\t\t\tconst dx = Math.cos(mid), dy = Math.sin(mid);\n\t\t\tconst verticalLabel = Math.abs(dx) < 0.35;\n\t\t\tconst labelAnchor = verticalLabel ? "middle" : dx > 0 ? "start" : "end";\n\t\t\tconst lx = cx + (verticalLabel ? r : r + labelGap) * dx;\n\t\t\tconst ly = cy + (r + labelGap) * (verticalLabel ? Math.sign(dy) : dy);', 1)
  chartReplace('<text x="${lx}" y="${ly}" text-anchor="middle"', '<text x="${lx}" y="${ly}" text-anchor="${labelAnchor}" dominant-baseline="middle"', 1)
  output = output.slice(0, start) + chart + output.slice(end)
  // Positive values crop (cover); negative values add empty margins (contain).
  // Both use the same existing source rectangle math in renderImageElement.
  for (const side of ['l', 't', 'r', 'b']) replace(`Math.max(0, Number(srcRect.getAttribute("${side}") || 0))`, `Number(srcRect.getAttribute("${side}") || 0)`)
  // An explicit DrawingML noFill cancels a border, including inherited table
  // borders. Dropping that signal makes upstream draw its 1px black fallback.
  replace('const ln = tcPr.getElementsByTagNameNS("*", key)[0] ?? null;\n\t\t\tif (!ln) continue;',
    'const ln = tcPr.getElementsByTagNameNS("*", key)[0] ?? null;\n\t\t\tif (!ln) continue;\n\t\t\tif (Array.from(ln.childNodes).some(node => node.localName === "noFill")) {\n\t\t\t\tborders[map[key]] = { style: "none", width: 0 };\n\t\t\t\tcontinue;\n\t\t\t}')
  replace('const ln = node.getElementsByTagNameNS("*", "ln")[0] ?? node;\n\t\t\tconst wAttr',
    'const ln = node.getElementsByTagNameNS("*", "ln")[0] ?? node;\n\t\t\tif (Array.from(ln.childNodes).some(child => child.localName === "noFill")) {\n\t\t\t\tborders[map[tag]] = { style: "none", width: 0 };\n\t\t\t\tcontinue;\n\t\t\t}\n\t\t\tconst wAttr')
  replace('const apply = (side, b) => {\n\t\tif (!b) return;\n\t\tconst w = b.width ?? 1;',
    'const apply = (side, b) => {\n\t\tif (!b) return;\n\t\tif (b.style === "none") { css.push(`border-${side}:none;`); return; }\n\t\tconst w = b.width ?? 1;')
  // Border noFill is not cell noFill; inspecting descendants also erased the
  // cell's explicitly chosen background whenever just one edge was hidden.
  replace('if (tcPr.getElementsByTagNameNS("*", "noFill")[0]) return void 0;\n\t\tconst direct = Array.from(tcPr.children).find((c) => c.localName === "solidFill");',
    'if (Array.from(tcPr.childNodes).some(node => node.localName === "noFill")) return void 0;\n\t\tconst direct = Array.from(tcPr.childNodes).find((c) => c.localName === "solidFill");')
  return output
}

export function pptxPreviewPatch() {
  return { name: 'aether-pptx-preview', enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (id.replaceAll('\\', '/').split('?')[0].endsWith('/@jvmr/pptx-to-html/dist/index.js')) return { code: patchPptxPreview(source), map: null }
      return undefined
    }
  }
}
