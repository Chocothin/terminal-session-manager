export class IOSViewportFix {
  private lastScrollY = 0;
  private isKeyboardVisible = false;

  constructor() {
    if (!this.isIOS()) return;
    this.init();
  }

  private isIOS(): boolean {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || 
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  private init(): void {
    if (!window.visualViewport) return;

    window.visualViewport.addEventListener('resize', () => {
      if (!window.visualViewport) return;
      const heightDiff = window.innerHeight - window.visualViewport.height;
      const wasVisible = this.isKeyboardVisible;
      this.isKeyboardVisible = heightDiff > 150;

      if (this.isKeyboardVisible && !wasVisible) {
        this.lastScrollY = window.scrollY;
      } else if (!this.isKeyboardVisible && wasVisible) {
        if (this.lastScrollY > 0) {
          window.scrollTo(0, this.lastScrollY);
          this.lastScrollY = 0;
        }
      }
    });
  }

  setContainers(): void {}
  dispose(): void {}
}
