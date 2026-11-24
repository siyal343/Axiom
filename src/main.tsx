import "./styles/theme.css";
import { render } from "preact";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (rootEl) {
  render(<App />, rootEl);
}
