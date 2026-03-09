(function () {
  var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return;

  function revealProductCards() {
    var cards = Array.from(document.querySelectorAll('.products .card'));
    if (!cards.length) return;

    if (!('IntersectionObserver' in window)) {
      cards.forEach(function (card) {
        card.classList.add('is-visible');
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.14,
      rootMargin: '0px 0px -8% 0px'
    });

    cards.forEach(function (card) {
      observer.observe(card);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    revealProductCards();
  });
})();