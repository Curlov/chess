/**
 * Benchmark-Helfer für reproduzierbare Engine-Messungen im Browser.
 * Die Funktionen werden auf `window` registriert, um direkt über die Konsole
 * unterschiedliche TT-/Zeit-/Depth-Profile testen zu können.
 */
const DEFAULT_BENCH_FEN = "r3k2r/p1ppqpb1/bn2pnp1/2pP4/1p2P3/2N2N2/PPQ1BPPP/R1B2RK1 w kq - 0 1";
const DEFAULT_TT_LIST = [0, 32, 64, 128, 256];

/** Normalisiert numerische Eingaben auf finite Number oder null. */
function toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Linear interpoliertes Quantil auf bereits sortiertem Array. */
function percentile(sortedAsc, p) {
    if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
    if (sortedAsc.length === 1) return sortedAsc[0];

    const ratio = Math.max(0, Math.min(1, p));
    const idx = (sortedAsc.length - 1) * ratio;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    const t = idx - lo;
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * t;
}

/** Arithmetisches Mittel über ein Zahlen-Array. */
function average(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

/** Baut künstliche History-Zeilen für history-basierte Engine-Tests. */
function buildHistory(fen, lines) {
    const count = Math.max(0, Number(lines) || 0);
    if (count <= 0) return "";
    return Array.from({ length: count }, () => fen).join("\n");
}

/** Führt genau einen Benchmark-Run aus und extrahiert zentrale Kennzahlen. */
async function measureRun(runFn) {
    const t0 = performance.now();
    const raw = await runFn();
    const wallMs = performance.now() - t0;

    const data = raw && typeof raw === "object" && raw.result && typeof raw.result === "object"
        ? raw.result
        : raw;

    return {
        wallMs,
        engineMs: toFiniteNumber(data?.time_ms),
        nodes: toFiniteNumber(data?.nodes),
        nps: toFiniteNumber(data?.nps),
        depth: toFiniteNumber(data?.depth),
        score: toFiniteNumber(data?.score),
        best: typeof data?.best === "string" ? data.best : "",
        book: data?.book === true,
        repAvoid: data?.rep_avoid === true
    };
}

/** Verdichtet mehrere Einzelläufe einer TT-Stufe zu einer Statistik-Zeile. */
function summarizeCase(ttMb, rows) {
    const wall = rows.map((r) => r.wallMs).filter((v) => Number.isFinite(v));
    const engine = rows.map((r) => r.engineMs).filter((v) => Number.isFinite(v));
    const nodes = rows.map((r) => r.nodes).filter((v) => Number.isFinite(v));
    const nps = rows.map((r) => r.nps).filter((v) => Number.isFinite(v));

    wall.sort((a, b) => a - b);

    const nodesSum = nodes.reduce((acc, v) => acc + v, 0);
    const engineMsSum = engine.reduce((acc, v) => acc + v, 0);
    const wallMsSum = wall.reduce((acc, v) => acc + v, 0);
    const effectiveNps = engineMsSum > 0
        ? (nodesSum * 1000) / engineMsSum
        : (wallMsSum > 0 ? (nodesSum * 1000) / wallMsSum : null);

    const sample = rows.length > 0 ? rows[rows.length - 1] : null;

    return {
        ttMb,
        runs: rows.length,
        wallAvgMs: average(wall),
        wallP50Ms: percentile(wall, 0.5),
        wallP95Ms: percentile(wall, 0.95),
        engineAvgMs: average(engine),
        nodesAvg: average(nodes),
        npsAvg: average(nps),
        npsEffective: effectiveNps,
        sampleDepth: sample?.depth ?? null,
        sampleScore: sample?.score ?? null,
        sampleBest: sample?.best ?? "",
        sampleBook: sample?.book ?? false,
        sampleRepAvoid: sample?.repAvoid ?? false
    };
}

/** Formatiert die Kennzahlen für `console.table`. */
function toTableRow(row) {
    return {
        ttMb: row.ttMb,
        runs: row.runs,
        wallAvgMs: row.wallAvgMs != null ? Number(row.wallAvgMs.toFixed(2)) : null,
        wallP50Ms: row.wallP50Ms != null ? Number(row.wallP50Ms.toFixed(2)) : null,
        wallP95Ms: row.wallP95Ms != null ? Number(row.wallP95Ms.toFixed(2)) : null,
        engineAvgMs: row.engineAvgMs != null ? Number(row.engineAvgMs.toFixed(2)) : null,
        nodesAvg: row.nodesAvg != null ? Math.round(row.nodesAvg) : null,
        npsAvg: row.npsAvg != null ? Math.round(row.npsAvg) : null,
        npsEffective: row.npsEffective != null ? Math.round(row.npsEffective) : null,
        best: row.sampleBest,
        book: row.sampleBook
    };
}

/**
 * Registriert globale Benchmark-Funktionen:
 * - `engineBench`
 * - `engineBenchQuick`
 * - `engineBenchTT`
 * - `engineBenchTime`
 */
export function registerEngineBench(controller) {
    if (!controller) {
        console.warn("[engineBench] controller missing");
        return;
    }

    const runBenchmark = async (options = {}) => {
        const mode = options.mode === "controller" ? "controller" : "raw";
        const fen = typeof options.fen === "string" && options.fen.trim()
            ? options.fen.trim()
            : DEFAULT_BENCH_FEN;
        const timeMs = Math.max(0, Number(options.timeMs) || 0);
        const depthInput = Number(options.depth);
        const depth = Number.isFinite(depthInput) && depthInput >= 0
            ? Math.floor(depthInput)
            : (timeMs > 0 ? 0 : 7);
        const runs = Math.max(1, Number(options.runs) || 5);
        const warmup = Math.max(0, Number(options.warmup) || 1);
        const historyLines = Math.max(0, Number(options.historyLines) || 0);
        const ttMbList = Array.isArray(options.ttMbList) && options.ttMbList.length
            ? options.ttMbList.map((v) => Math.max(0, Number(v) || 0))
            : DEFAULT_TT_LIST.slice();
        const logTable = options.logTable !== false;

        if (mode === "raw" && (!controller.engine || typeof controller.engine.search !== "function")) {
            throw new Error("engineBench raw mode: controller.engine.search fehlt");
        }

        const history = mode === "raw" ? buildHistory(fen, historyLines) : "";
        const rows = [];

        for (const ttMb of ttMbList) {
            const runFn = mode === "raw"
                ? () => controller.engine.search(
                    fen,
                    depth,
                    timeMs,
                    ttMb,
                    history,
                    { gameId: -1, bookEnabled: false, uciHistory: "", debugRootEval: false }
                )
                : () => controller.search({ fen, depth, timeMs, ttMb, debugRootEval: false });

            for (let i = 0; i < warmup; i += 1) {
                await runFn();
            }

            const measured = [];
            for (let i = 0; i < runs; i += 1) {
                measured.push(await measureRun(runFn));
            }
            rows.push(summarizeCase(ttMb, measured));
        }

        const out = {
            meta: {
                mode,
                fen,
                depth,
                timeMs,
                runs,
                warmup,
                historyLines,
                ttMbList,
                createdAt: new Date().toISOString()
            },
            rows
        };

        window.lastEngineBench = out;

        if (logTable) {
            console.log("[engineBench] done", out.meta);
            console.table(rows.map(toTableRow));
        }

        return out;
    };

    window.engineBench = runBenchmark;
    window.engineBenchQuick = (overrides = {}) => runBenchmark({
        depth: 6,
        runs: 3,
        warmup: 1,
        ttMbList: [0, 64, 128, 256],
        ...overrides
    });
    window.engineBenchTT = (overrides = {}) => runBenchmark({
        mode: "raw",
        depth: 7,
        runs: 5,
        warmup: 2,
        ttMbList: [0, 32, 64, 128, 256],
        ...overrides
    });
    window.engineBenchTime = (overrides = {}) => runBenchmark({
        mode: "controller",
        depth: 0,
        timeMs: 12500,
        runs: 3,
        warmup: 1,
        ttMbList: [64, 128, 256],
        ...overrides
    });

    console.log("[engineBench] registered", {
        defaults: {
            fen: DEFAULT_BENCH_FEN,
            mode: "raw",
            depth: 7,
            runs: 5,
            warmup: 1,
            ttMbList: DEFAULT_TT_LIST
        }
    });
}
