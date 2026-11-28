// @vitest-environment jsdom
import { h, render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { extractHintFromAnswer } from "../../store/studyStore";
import { renderMarkdownToSanitizedHtml } from "../markdownCache";
import { VisualSimBlock } from "../VisualSimBlock";
import {
  evaluateSafeMathExpression,
  evaluateVisualSim,
  parseVisualSimSpec,
} from "../visualSimEngine";

describe("visualSimEngine & Markdown/Preact integration", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("evaluates 2nd-order step response across underdamped and overdamped regimes", () => {
    const spec = parseVisualSimSpec(
      JSON.stringify({
        domain: "controls",
        kind: "response",
        preset: "second_order_step",
        params: [
          { id: "zeta", label: "Damping", min: 0.1, max: 1.5, step: 0.05, value: 0.3 },
          { id: "wn", label: "Omega", min: 1, max: 10, step: 0.5, value: 4 },
        ],
      }),
    );
    expect(spec).not.toBeNull();
    if (!spec) return;

    const under = evaluateVisualSim(spec, { zeta: 0.3, wn: 4 });
    expect(under.primary.length).toBeGreaterThan(100);
    expect(under.regimeLabel).toBe("Underdamped");
    const osUnder = under.metrics.find((m) => m.label === "%OS")?.value;
    expect(osUnder).toBe("37.2%");

    const over = evaluateVisualSim(spec, { zeta: 1.25, wn: 4 });
    expect(over.regimeLabel).toBe("Overdamped");
    expect(over.metrics.find((m) => m.label === "%OS")?.value).toBe("0.0%");
  });

  it("computes accurate RF Smith chart reflection coefficient, VSWR, and Return Loss", () => {
    const spec = parseVisualSimSpec(
      JSON.stringify({
        domain: "rf",
        kind: "smith",
        preset: "smith",
      }),
    );
    expect(spec).not.toBeNull();
    if (!spec) return;

    // Matched 50 ohm load
    const matched = evaluateVisualSim(spec, { rl: 50, xl: 0, z0: 50 });
    expect(matched.smith?.gammaMag).toBeCloseTo(0, 3);
    expect(matched.smith?.vswr).toBeCloseTo(1.0, 2);

    // 100 ohm resistive mismatch -> |Gamma| = (100-50)/(100+50) = 1/3, VSWR = 2.00
    const mismatched = evaluateVisualSim(spec, { rl: 100, xl: 0, z0: 50 });
    expect(mismatched.smith?.gammaMag).toBeCloseTo(1 / 3, 2);
    expect(mismatched.smith?.vswr).toBeCloseTo(2.0, 2);
  });

  it("computes embedded SPI edge modes and PWM+RC ripple", () => {
    const spi = parseVisualSimSpec(
      JSON.stringify({ domain: "embedded", kind: "timing", preset: "spi_timing" }),
    )!;
    const mode1 = evaluateVisualSim(spi, { cpol: 0, cpha: 1 });
    expect(mode1.regimeLabel).toBe("SPI Mode 1");
    expect(mode1.metrics.find((m) => m.label === "Sample")?.value).toContain("Falling");

    const pwm = parseVisualSimSpec(
      JSON.stringify({ domain: "embedded", kind: "response", preset: "pwm_rc" }),
    )!;
    const out = evaluateVisualSim(pwm, { duty: 50, freq_khz: 10, rc_ms: 0.4, vcc: 3.3 });
    expect(out.metrics.find((m) => m.label === "V_avg")?.value).toBe("1.65 V");
  });

  it("safely evaluates parametric physics math expressions without eval and blocks unsupported syntax", () => {
    const val = evaluateSafeMathExpression("a * exp(-g * x) * cos(w * x)", {
      a: 2,
      g: 0,
      w: Math.PI,
      x: 1,
    });
    expect(val).toBeCloseTo(-2, 5);
    expect(() => evaluateSafeMathExpression("window.alert(1)", { x: 1 })).toThrow();
  });

  it("renders axiom-sim fences through DOMPurify safely and updates SVG live on slider change", async () => {
    const md = [
      "Analyze damping before plotting.",
      "",
      "```axiom-sim",
      JSON.stringify({
        title: "RLC Step Test <img src=x onerror=alert(1)>",
        domain: "physics",
        preset: "damped_wave",
      }),
      "```",
    ].join("\n");

    const html = renderMarkdownToSanitizedHtml(md);
    expect(html).toContain('class="axiom-sim-mount"');
    expect(html).toContain("data-sim=");
    expect(html).not.toMatch(/<(?:img|script)/i);

    const mount = document.createElement("div");
    mount.innerHTML = html;
    document.body.appendChild(mount);
    expect(mount.querySelector("img")).toBeNull();

    const simMount = mount.querySelector<HTMLElement>(".axiom-sim-mount[data-sim]");
    expect(simMount).not.toBeNull();
    const spec = parseVisualSimSpec(simMount?.getAttribute("data-sim") ?? "");
    expect(spec).not.toBeNull();
    if (!simMount || !spec) return;

    render(h(VisualSimBlock, { spec }), simMount);
    const omegaSlider = simMount.querySelector<HTMLInputElement>('input[type="range"][aria-label="Angular ω"]');
    expect(omegaSlider).not.toBeNull();
    expect(simMount.textContent).toContain("1.26 s");

    if (omegaSlider) {
      omegaSlider.value = "10";
      omegaSlider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      expect(simMount.textContent).toContain("0.63 s");
    }
    render(null, simMount);
  });

  it("shows compiling placeholder for unclosed streaming axiom-sim fences and strips sims from study hints", () => {
    const streamingMd = "Intro\n```axiom-sim\n{\"preset\":\"smith\"";
    const html = renderMarkdownToSanitizedHtml(streamingMd);
    expect(html).toContain("axiom-sim-streaming");

    const answerWithSim =
      "**Governing Law:** Reflection matches $Z_L = Z_0$.\n```axiom-sim\n{\"preset\":\"smith\"}\n```";
    const hint = extractHintFromAnswer(answerWithSim);
    expect(hint).not.toContain("axiom-sim");
    expect(hint).not.toContain('"preset"');
    expect(hint).toContain("Governing Law");
  });

  it("renders Smith Chart inductive/capacitive region cues and syncs sliders when spec changes", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);

    const smithSpec = parseVisualSimSpec(JSON.stringify({ domain: "rf", preset: "smith" }))!;
    render(h(VisualSimBlock, { spec: smithSpec }), mount);
    expect(mount.textContent).toContain("+jX Inductive");
    expect(mount.textContent).toContain("−jX Capacitive");

    const stepSpec = parseVisualSimSpec(
      JSON.stringify({ domain: "controls", preset: "second_order_step" }),
    )!;
    render(h(VisualSimBlock, { spec: stepSpec }), mount);
    expect(mount.textContent).toContain("2nd-Order Closed-Loop Step Response");
    render(null, mount);
  });

  it("evaluates generalized Bode log-scale multi-series, custom metrics, and piecewise/asymptote splitting", () => {
    const bodeSpec = parseVisualSimSpec(
      JSON.stringify({
        title: "RC Low-Pass Bode",
        domain: "circuits",
        kind: "bode",
        xMin: 10,
        xMax: 100000,
        xLabel: "f (Hz)",
        yLabel: "Gain (dB)",
        series: [
          { label: "|H(f)| dB", expr: "-10*log10(1 + (x/fc)^2)", color: "accent" },
          { label: "Asymptote", expr: "ifelse(x - fc, -20*log10(x/fc), 0)", color: "warn", dashed: true },
        ],
        hLines: [{ y: -3, label: "-3 dB" }],
        vLines: [{ x: 1000 }],
        metrics: [{ label: "fc", expr: "fc", unit: "Hz", precision: 0 }],
        params: [{ id: "fc", label: "Cutoff fc", unit: "Hz", min: 100, max: 10000, step: 100, value: 1000 }],
      }),
    )!;
    expect(bodeSpec.preset).toBe("custom_expr");
    expect(bodeSpec.xScale).toBe("log");
    expect(bodeSpec.domain).toBe("circuits");

    const sim = evaluateVisualSim(bodeSpec, { fc: 1000 });
    expect(sim.xScale).toBe("log");
    expect(sim.series).toHaveLength(2);
    expect(sim.metrics[0]?.value).toBe("1000 Hz");
    const fcPt = sim.series?.[0]?.segments[0]?.find((p) => Math.abs(p.x - 1000) < 150);
    expect(fcPt).toBeDefined();

    // Discontinuity / step / asymptote safety
    const tanSpec = parseVisualSimSpec(
      JSON.stringify({
        kind: "plot",
        xMin: 0.1,
        xMax: 3.0,
        expr: "tan(x)",
        params: [],
      }),
    )!;
    const tanSim = evaluateVisualSim(tanSpec, {});
    expect((tanSim.series?.[0]?.segments.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect(evaluateSafeMathExpression("step(x) * sinc(0) + ifelse(1, 2, 0)", { x: 0.5 })).toBe(3);
  });

  it("evaluates 2D parametric, polar RF pattern, custom timing channels, and animated time controls", async () => {
    const paramSpec = parseVisualSimSpec(
      JSON.stringify({
        title: "Projectile Motion",
        domain: "mechanics",
        kind: "parametric",
        sMin: 0,
        sMax: 3,
        series: [{ label: "Path", xExpr: "v0*cos(ang)*s", yExpr: "v0*sin(ang)*s - 4.9*s^2" }],
        markers: [{ label: "Apex", xExpr: "(v0^2*sin(2*ang))/19.6", yExpr: "(v0*sin(ang))^2/19.6", tone: "good" }],
        metrics: [{ label: "Range", expr: "(v0^2*sin(2*ang))/9.8", unit: "m" }],
        params: [
          { id: "v0", label: "Speed", unit: "m/s", min: 5, max: 20, step: 1, value: 10 },
          { id: "ang", label: "Angle", unit: "rad", min: 0.2, max: 1.3, step: 0.05, value: 0.785 },
        ],
      }),
    )!;
    const paramEval = evaluateVisualSim(paramSpec, { v0: 10, ang: Math.PI / 4 });
    expect(paramEval.kind).toBe("parametric");
    expect(paramEval.markers?.[0]?.label).toBe("Apex");
    expect(paramEval.markers?.[0]?.y).toBeCloseTo(2.55, 1);

    const polarSpec = parseVisualSimSpec(
      JSON.stringify({
        title: "Dipole Pattern",
        domain: "rf",
        kind: "polar",
        series: [{ label: "|E(θ)|", expr: "abs(cos(g * cos(theta)))" }],
        params: [{ id: "g", label: "Factor", min: 0.5, max: 2.5, step: 0.1, value: 1.5 }],
      }),
    )!;
    const polarEval = evaluateVisualSim(polarSpec, { g: 1.5 });
    expect(polarEval.kind).toBe("polar");
    expect(polarEval.polar?.series[0]?.points.length).toBeGreaterThan(100);

    const timingSpec = parseVisualSimSpec(
      JSON.stringify({
        title: "Quadrature Encoder",
        domain: "embedded",
        kind: "timing",
        xMin: 0,
        xMax: 4,
        channels: [
          { name: "CHA", expr: "sin(2*pi*x)" },
          { name: "CHB", expr: "sin(2*pi*x - phi)", color: "good" },
        ],
        params: [{ id: "phi", label: "Phase", unit: "rad", min: 0, max: 3.14, step: 0.1, value: 1.57 }],
      }),
    )!;
    const timingEval = evaluateVisualSim(timingSpec, { phi: 1.57 });
    expect(timingEval.preset).toBe("custom_expr");
    expect(timingEval.timing?.channels.map((c) => c.name)).toEqual(["CHA", "CHB"]);

    const waveMount = document.createElement("div");
    document.body.appendChild(waveMount);
    const waveSpec = parseVisualSimSpec(
      JSON.stringify({
        title: "Traveling Wave",
        domain: "signals",
        kind: "wave",
        xMin: 0,
        xMax: 6.28,
        expr: "sin(k*x - 4*time)",
        params: [{ id: "k", label: "k", min: 1, max: 4, step: 0.5, value: 2 }],
      }),
    )!;
    expect(waveSpec.animate).toBe(true);
    render(h(VisualSimBlock, { spec: waveSpec }), waveMount);
    const playBtn = waveMount.querySelector<HTMLButtonElement>(".axiom-sim__play-btn");
    expect(playBtn?.textContent).toBe("Play");
    playBtn?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(playBtn?.textContent).toBe("Pause");
    render(null, waveMount);
  });
});
