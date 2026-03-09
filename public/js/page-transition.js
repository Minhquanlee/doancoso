(function () {
  var body = document.body;
  if (!body) return;

  var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var leaveDuration = 180;

  function clearTransitionState() {
    body.classList.remove('page-is-leaving');
    body.classList.remove('page-is-entering');
    document.querySelectorAll('.nav-pressed').forEach(function (element) {
      element.classList.remove('nav-pressed');
    });
  }

  function runEnterAnimation() {
    if (prefersReducedMotion) return;
    clearTransitionState();
    body.classList.add('page-is-entering');
    window.setTimeout(function () {
      body.classList.remove('page-is-entering');
    }, 260);
  }

  function isInternalNavigableLink(link) {
    if (!link) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.hasAttribute('download')) return false;
    if (link.getAttribute('data-no-transition') === 'true') return false;

    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return false;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return false;

    var url;
    try {
      url = new URL(link.href, window.location.href);
    } catch (error) {
      return false;
    }

    if (url.origin !== window.location.origin) return false;
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return false;

    return true;
  }

  function markPressed(link) {
    if (!link) return;
    if (link.matches('.cat') || link.closest('.mobile-cats') || link.closest('.categories')) {
      link.classList.add('nav-pressed');
    }
  }

  window.addEventListener('pageshow', function () {
    runEnterAnimation();
  });

  document.addEventListener('DOMContentLoaded', function () {
    runEnterAnimation();
  });

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a');
    if (!link) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!isInternalNavigableLink(link)) return;
    if (prefersReducedMotion) return;

    event.preventDefault();
    clearTransitionState();
    markPressed(link);
    body.classList.add('page-is-leaving');

    window.setTimeout(function () {
      window.location.href = link.href;
    }, leaveDuration);
  }, true);
})();