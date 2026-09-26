/**
 * Writes xr100-outline.pdf: a board outline drawing whose dimensions exist only as lines, like a
 * CAD export. The title and notes are PDF text (so kb_search finds the document); every number
 * is drawn with a stroke font, so the converted text has none of them and only kb_read's view
 * shows them. Run: node scripts/model-check/corpus/xr100-outline.ts
 *
 * The board: 62 × 38 mm, four M3 mounting holes 4 mm in from each edge, so 54 × 30 mm apart.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MM = 6; // points per millimetre on the page
const ORIGIN = { x: 230, y: 170 }; // bottom-left corner of the board on the page
const BOARD = { w: 62, h: 38 };
const INSET = 4;
const HOLE = 3.2; // M3 clearance

const ops: string[] = [];
const pt = (mmX: number, mmY: number) => [ORIGIN.x + mmX * MM, ORIGIN.y + mmY * MM];
const f = (n: number) => n.toFixed(2);

function line(x1: number, y1: number, x2: number, y2: number) {
	ops.push(`${f(x1)} ${f(y1)} m ${f(x2)} ${f(y2)} l S`);
}

function circle(cx: number, cy: number, r: number) {
	const k = 0.5523 * r;
	ops.push(
		`${f(cx + r)} ${f(cy)} m`,
		`${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
		`${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
		`${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
		`${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c S`,
	);
}

// Stroke font on a 4 × 6 grid, y up: each glyph is a list of polylines.
const GLYPHS: Record<string, number[][][]> = {
	"0": [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]]],
	"1": [[[1, 5], [2, 6], [2, 0]]],
	"2": [[[0, 6], [4, 6], [4, 3], [0, 3], [0, 0], [4, 0]]],
	"3": [[[0, 6], [4, 6], [4, 0], [0, 0]], [[0, 3], [4, 3]]],
	"4": [[[0, 6], [0, 3], [4, 3]], [[3, 6], [3, 0]]],
	"5": [[[4, 6], [0, 6], [0, 3], [4, 3], [4, 0], [0, 0]]],
	"6": [[[4, 6], [0, 6], [0, 0], [4, 0], [4, 3], [0, 3]]],
	"7": [[[0, 6], [4, 6], [1, 0]]],
	"8": [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 0]], [[0, 3], [4, 3]]],
	"9": [[[0, 0], [4, 0], [4, 6], [0, 6], [0, 3], [4, 3]]],
	M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
	"-": [[[0.5, 3], [3.5, 3]]],
	".": [[[1.6, 0], [2.4, 0], [2.4, 0.8], [1.6, 0.8], [1.6, 0]]],
	"Ø": [[[0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 1], [3, 0], [1, 0], [0, 1]], [[0, -0.5], [4, 6.5]]],
};

/** Draw a label with the stroke font; `size` is the glyph height in points, centred on (x, y). */
function strokeText(label: string, x: number, y: number, size = 10, vertical = false) {
	const s = size / 6;
	const advance = 5.5 * s;
	const width = label.length * advance - 1.5 * s;
	[...label].forEach((ch, i) => {
		for (const poly of GLYPHS[ch] ?? []) {
			const points = poly.map(([gx, gy]) => {
				const along = -width / 2 + i * advance + gx * s;
				const across = gy * s - size / 2;
				return vertical ? [x - across, y + along] : [x + along, y + across];
			});
			ops.push(`${points.map(([px, py], j) => `${f(px)} ${f(py)} ${j ? "l" : "m"}`).join(" ")} S`);
		}
	});
}

function arrow(x: number, y: number, dx: number, dy: number) {
	const len = 5, half = 1.8;
	const [px, py] = [-dy, dx];
	ops.push(`${f(x)} ${f(y)} m ${f(x - dx * len + px * half)} ${f(y - dy * len + py * half)} l ${f(x - dx * len - px * half)} ${f(y - dy * len - py * half)} l f`);
}

/** A horizontal dimension between two x positions (mm), drawn `offset` mm from the reference y. */
function hDim(x1: number, x2: number, refY: number, offset: number, label: string) {
	const [ax, ay] = pt(x1, refY), [bx] = pt(x2, refY);
	const y = ay + offset * MM;
	line(ax, ay, ax, y + Math.sign(offset) * 4);
	line(bx, ay, bx, y + Math.sign(offset) * 4);
	line(ax, y, bx, y);
	arrow(ax, y, -1, 0);
	arrow(bx, y, 1, 0);
	strokeText(label, (ax + bx) / 2, y + 9);
}

/** A vertical dimension between two y positions (mm), drawn `offset` mm from the reference x. */
function vDim(y1: number, y2: number, refX: number, offset: number, label: string) {
	const [ax, ay] = pt(refX, y1), [, by] = pt(refX, y2);
	const x = ax + offset * MM;
	line(ax, ay, x + Math.sign(offset) * 4, ay);
	line(ax, by, x + Math.sign(offset) * 4, by);
	line(x, ay, x, by);
	arrow(x, ay, 0, -1);
	arrow(x, by, 0, 1);
	strokeText(label, x - 9 * Math.sign(-offset || 1), (ay + by) / 2, 10, true);
}

ops.push("0.9 w 0 0 0 RG 0 0 0 rg 1 J 1 j");

// Board outline and holes.
const [bx, by] = pt(0, 0);
ops.push(`${f(bx)} ${f(by)} ${f(BOARD.w * MM)} ${f(BOARD.h * MM)} re S`);
const holes = [[INSET, INSET], [BOARD.w - INSET, INSET], [INSET, BOARD.h - INSET], [BOARD.w - INSET, BOARD.h - INSET]];
for (const [hx, hy] of holes) {
	const [cx, cy] = pt(hx, hy);
	circle(cx, cy, (HOLE / 2) * MM);
	ops.push("0.3 w");
	line(cx - 12, cy, cx + 12, cy);
	line(cx, cy - 12, cx, cy + 12);
	ops.push("0.9 w");
}

// Parts: the chip, connector J1 on the left edge (not named USB-C: the "missing" scenario asks about USB-C power), a 2×5 header.
const [chipX, chipY] = pt(24, 14);
ops.push(`${f(chipX)} ${f(chipY)} ${f(12 * MM)} ${f(12 * MM)} re S`);
const [j1X, j1Y] = pt(-1.5, 15);
ops.push(`${f(j1X)} ${f(j1Y)} ${f(8 * MM)} ${f(9 * MM)} re S`);
for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++) {
	const [hx, hy] = pt(50 + c * 2.54, 12.5 + r * 2.54);
	circle(hx, hy, 0.5 * MM);
}

// Dimensions, all stroked.
hDim(0, BOARD.w, 0, -7, "62");
hDim(INSET, BOARD.w - INSET, BOARD.h, 5, "54");
vDim(0, BOARD.h, 0, -7, "38");
vDim(INSET, BOARD.h - INSET, BOARD.w, 5, "30");
hDim(0, INSET, BOARD.h, 10, "4");
// Hole callout with a leader to the bottom-right hole.
const [lx, ly] = pt(BOARD.w - INSET, INSET);
line(lx + 6, ly - 6, lx + 40, ly - 40);
line(lx + 40, ly - 40, lx + 95, ly - 40);
strokeText("4-M3", lx + 67, ly - 31);
strokeText("Ø3.2", lx + 67, ly - 50);

// Real text: title block and notes. No numbers from the drawing appear here.
const text = (x: number, y: number, size: number, s: string) =>
	ops.push(`BT /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()\\]/g, "\\$&")}) Tj ET`);
text(60, 540, 16, "XR-100 Evaluation Board - Outline Drawing (top view)");
text(60, 518, 10, "Mechanical drawing for enclosure and bracket design. Dimensions are shown on the drawing.");
text(60, 90, 9, "Notes: mounting holes are plated and connected to GND. Board thickness per fabrication notes.");
text(60, 76, 9, "Tolerance +/-0.2 unless stated. UNIT: mm");
const [labelX, labelY] = pt(26.5, 19.5);
text(labelX, labelY, 9, "XR-100");
const [j1LabelX, j1LabelY] = pt(0.5, 27);
text(j1LabelX, j1LabelY, 7, "J1");

const content = ops.join("\n");
const objects = [
	"<< /Type /Catalog /Pages 2 0 R >>",
	"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
	"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
	"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets: number[] = [];
objects.forEach((body, i) => {
	offsets.push(Buffer.byteLength(pdf));
	pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(import.meta.dirname, "xr100-outline.pdf"), pdf);
