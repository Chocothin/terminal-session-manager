import { hapticFeedback } from './haptics.js';

const TOKEN_STORAGE_KEY = 'tsm-auth-token';

export class AuthScreen {
  private container: HTMLElement;
  private tokenInput: HTMLInputElement;
  private errorElement: HTMLElement;
  private submitCallback: ((token: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.className = 'auth-screen';

    const card = document.createElement('div');
    card.className = 'auth-card';

    const title = document.createElement('h1');
    title.className = 'auth-title';
    title.textContent = 'Terminal Session Manager';

    const subtitle = document.createElement('p');
    subtitle.className = 'auth-subtitle';
    subtitle.textContent = 'Connect to your terminal sessions';

    const form = document.createElement('form');
    form.className = 'auth-form';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleSubmit();
    });

    const inputGroup = document.createElement('div');
    inputGroup.className = 'input-group';

    const label = document.createElement('label');
    label.textContent = 'Access Token';
    label.htmlFor = 'token-input';

    this.tokenInput = document.createElement('input');
    this.tokenInput.type = 'password';
    this.tokenInput.id = 'token-input';
    this.tokenInput.className = 'token-input';
    this.tokenInput.placeholder = 'Enter your token';
    this.tokenInput.autocomplete = 'off';

    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY) ?? sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (savedToken) {
      this.tokenInput.value = savedToken;
      localStorage.setItem(TOKEN_STORAGE_KEY, savedToken);
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    this.errorElement = document.createElement('div');
    this.errorElement.className = 'auth-error';

    const button = document.createElement('button');
    button.type = 'submit';
    button.className = 'btn-connect';
    button.textContent = 'Connect';

    inputGroup.appendChild(label);
    inputGroup.appendChild(this.tokenInput);

    form.appendChild(inputGroup);
    form.appendChild(this.errorElement);
    form.appendChild(button);

    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(form);

    this.container.appendChild(card);
  }

  onSubmit(callback: (token: string) => void): void {
    this.submitCallback = callback;
  }

  show(): void {
    this.container.style.display = 'flex';
    this.tokenInput.focus();
  }

  hide(): void {
    this.container.style.display = 'none';
  }

  showError(message: string): void {
    this.errorElement.textContent = message;
    this.errorElement.style.display = 'block';
  }

  private handleSubmit(): void {
    const token = this.tokenInput.value.trim();
    
    if (!token) {
      hapticFeedback('heavy');
      this.showError('Please enter a token');
      return;
    }

    hapticFeedback('medium');
    this.errorElement.style.display = 'none';
    localStorage.setItem(TOKEN_STORAGE_KEY, token);

    if (this.submitCallback) {
      this.submitCallback(token);
    }
  }
}
