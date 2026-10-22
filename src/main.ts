import { mount } from "svelte";
import "./style.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) {
  throw new Error("找不到挂载节点 #app，请检查 index.html 是否包含 <div id=\"app\"></div>");
}
const app = mount(App, { target });

export default app;
