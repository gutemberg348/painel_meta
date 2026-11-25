lucide.createIcons();
document.getElementById('toggle-password').addEventListener('click', (event) => {
  const field = document.getElementById('password');
  const visible = field.type === 'password';
  field.type = visible ? 'text' : 'password';
  event.currentTarget.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  event.currentTarget.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
  lucide.createIcons();
});
