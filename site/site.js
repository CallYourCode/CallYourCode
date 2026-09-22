// Theme toggle (persisted, default dark) + copy buttons + docs hash routing.
(function () {
  var root = document.documentElement;
  function theme() { return root.dataset.theme || "dark"; }
  var toggle = document.querySelector(".theme-toggle");
  function paintToggle() { if (toggle) toggle.textContent = theme() === "dark" ? "light" : "dark"; }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = theme() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem("cyc-theme", next); } catch (e) {}
      paintToggle();
    });
    paintToggle();
  }

  var CMD = "curl -fsSL https://callyourcode.com/install.sh | sh && . ~/.callyourcode/env";
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = CMD;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(CMD).catch(fallback);
        else fallback();
      } catch (e) { fallback(); }
      var copy = btn.querySelector(".ic-copy"), check = btn.querySelector(".ic-check");
      if (copy && check) {
        copy.setAttribute("hidden", "");
        check.removeAttribute("hidden");
        setTimeout(function () {
          copy.removeAttribute("hidden");
          check.setAttribute("hidden", "");
        }, 1500);
      }
    });
  });

  var ptabs = document.querySelectorAll(".ptab");
  if (ptabs.length) {
    ptabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        ptabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
        document.querySelectorAll(".pt-panel").forEach(function (p) {
          p.hidden = p.dataset.panel !== tab.dataset.tab;
        });
      });
    });
  }

  var articles = document.querySelectorAll(".docs-article article[data-doc]");
  if (articles.length) {
    var links = document.querySelectorAll(".docs-nav a");
    function show() {
      var id = (location.hash || "#install").slice(1);
      var found = false;
      articles.forEach(function (a) {
        var on = a.dataset.doc === id;
        a.hidden = !on;
        if (on) found = true;
      });
      if (!found) { articles.forEach(function (a) { a.hidden = a.dataset.doc !== "install"; }); id = "install"; }
      links.forEach(function (l) { l.classList.toggle("active", l.getAttribute("href") === "#" + id); });
    }
    window.addEventListener("hashchange", function () { show(); window.scrollTo(0, 0); });
    show();
  }
})();
