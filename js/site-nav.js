(() => {
  const nav = document.querySelector('header nav, .main-header .navbar, nav.navbar');
  if (!nav) return;

  const links = [...nav.querySelectorAll('a')];
  let espn = links.find(a => /fantasy\.espn\.com/i.test(a.href) || /ESPN Fantasy Login/i.test(a.textContent || ''));
  if (!espn) {
    espn = document.createElement('a');
    espn.href = 'https://fantasy.espn.com/football/league?leagueId=843833275';
    espn.target = '_blank';
    espn.rel = 'noopener noreferrer';
    espn.textContent = 'ESPN Fantasy Login';
    nav.appendChild(espn);
  }
  espn.classList.add('espn-btn');
  espn.classList.remove('site-login-btn');

  let login = [...nav.querySelectorAll('a')].find(a => /(^|\/)login\.html(?:$|[?#])/i.test(a.getAttribute('href') || ''));
  if (!login) {
    login = document.createElement('a');
    login.href = 'login.html';
    login.textContent = 'Login';
    nav.appendChild(login);
  }
  login.textContent = 'Login';
  login.classList.add('site-login-btn');
  login.classList.remove('espn-btn');

  // Keep the two action buttons at the far right and always in the same order.
  nav.appendChild(espn);
  nav.appendChild(login);
})();
