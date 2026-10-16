const header = document.querySelector('.site-header');
const toggle = document.querySelector('.nav-toggle');

toggle.addEventListener('click', () => {
  const open = header.classList.toggle('nav-open');
  toggle.setAttribute('aria-expanded', open);
});
document.querySelectorAll('.nav-links a').forEach(a =>
  a.addEventListener('click', () => {
    header.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', false);
  })
);

addEventListener('scroll', () => header.classList.toggle('scrolled', scrollY > 10), { passive: true });

const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

document.querySelectorAll('.video-frame button').forEach(btn =>
  btn.addEventListener('click', () => {
    const f = document.createElement('iframe');
    f.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.id}?autoplay=1&rel=0`;
    f.title = btn.getAttribute('aria-label').replace('Play video: ', '');
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.allowFullscreen = true;
    btn.replaceWith(f);
  })
);

const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
