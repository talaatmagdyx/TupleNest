/* ============================================================================
   TupleNest site — shared behaviour
   Nav (solid-on-scroll, mobile menu), live GitHub stars, OS detection for the
   primary download button, FAQ accordion, scroll reveal, footer year.
   No third-party scripts, no analytics — the site ships nothing the app won't.
   ========================================================================== */
(function () {
  "use strict";
  var REPO = "talaatmagdyx/TupleNest";
  var LATEST = "https://github.com/" + REPO + "/releases/latest";

  /* ---- sticky nav: transparent over hero, solid after scroll ---- */
  var nav = document.querySelector("header.nav");
  function onScroll() {
    if (!nav) return;
    if (window.scrollY > 12) nav.classList.add("solid");
    else nav.classList.remove("solid");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- mobile menu ---- */
  var toggle = document.querySelector(".menu-toggle");
  var menu = document.querySelector(".mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      menu.classList.toggle("open");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") menu.classList.remove("open");
    });
  }

  /* ---- live GitHub star count (graceful: hidden if the call fails) ---- */
  var starEls = document.querySelectorAll("[data-stars]");
  if (starEls.length) {
    fetch("https://api.github.com/repos/" + REPO, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || typeof d.stargazers_count !== "number") return;
        var n = d.stargazers_count;
        var txt = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
        starEls.forEach(function (el) {
          el.textContent = "★ " + txt;
          el.classList.remove("hidden");
        });
      })
      .catch(function () {});
  }

  /* ---- OS detection: label the primary download buttons ---- */
  function detectOS() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var ua = navigator.userAgent || "";
    p = p.toLowerCase(); ua = ua.toLowerCase();
    if (p.indexOf("mac") > -1 || ua.indexOf("mac os") > -1) return "macOS";
    if (p.indexOf("win") > -1 || ua.indexOf("windows") > -1) return "Windows";
    if (p.indexOf("linux") > -1 || ua.indexOf("linux") > -1) return "Linux";
    return "macOS";
  }
  var os = detectOS();
  document.querySelectorAll("[data-download]").forEach(function (el) {
    var label = el.getAttribute("data-download-label");
    el.textContent = label ? label.replace("%OS%", os) : "Download for " + os;
    // Every OS points at the same GitHub Releases page — the assets live there,
    // and it is the honest source of truth for what actually exists per platform.
    if (!el.getAttribute("href")) el.setAttribute("href", LATEST);
  });

  /* ---- FAQ accordion ---- */
  document.querySelectorAll(".qa button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      btn.parentElement.classList.toggle("open");
    });
  });

  /* ---- scroll reveal ---- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- footer year ---- */
  var y = document.querySelector("[data-year]");
  if (y) y.textContent = new Date().getFullYear();
})();
