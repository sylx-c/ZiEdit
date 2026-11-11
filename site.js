(() => {
"use strict";
const root = document.documentElement;
let saved = null;
try {
saved = window.localStorage.getItem("ziedit-website-lang");
} catch (_) {
}
function setLanguage(language, persist = true) {
const languageCode = language === "en" ? "en" : "zh";
root.lang = languageCode === "en" ? "en" : "zh-CN";
document.querySelectorAll("[data-set-lang]").forEach((button) => {
const active = button.getAttribute("data-set-lang") === languageCode;
button.classList.toggle("active", active);
button.setAttribute("aria-pressed", String(active));
});
if (persist) {
try {
window.localStorage.setItem("ziedit-website-lang", languageCode);
} catch (_) {
}
}
}
setLanguage(saved, false);
document.addEventListener("DOMContentLoaded", () => {
setLanguage(root.lang === "en" ? "en" : "zh", false);
}, { once: true });
document.addEventListener("click", (event) => {
if (!(event.target instanceof Element)) return;
const languageButton = event.target.closest("[data-set-lang]");
if (languageButton) {
setLanguage(languageButton.getAttribute("data-set-lang"));
return;
}
if (event.target.closest(".nav-links a")) {
const navigationToggle = document.getElementById("nav-toggle");
if (navigationToggle) navigationToggle.checked = false;
}
});
// 版本号自动对齐：从 GitHub 最新正式 Release 读取标签并刷新页内 .version 文本。
// HTML 中的静态版本号（v1.0.1）仅为接口不可用时的兜底；下载链接始终指向 releases/latest。
fetch("https://api.github.com/repos/sylx-c/ZiEdit/releases/latest")
.then((response) => (response.ok ? response.json() : null))
.then((release) => {
if (!release || typeof release.tag_name !== "string") return;
const version = release.tag_name.trim();
if (!/^v?\d/.test(version)) return;
document.querySelectorAll(".version").forEach((element) => {
element.textContent = version.startsWith("v") ? version : `v${version}`;
});
})
.catch(() => {});
})();
