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
});
