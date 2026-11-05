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
})();
