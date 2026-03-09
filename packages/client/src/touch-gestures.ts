export class TouchGestures {
  private startX = 0;
  private startY = 0;
  private currentX = 0;
  private currentY = 0;
  private startTime = 0;
  private isSidebarOpenAtStart = false;
  private isDragging = false;
  private readonly SWIPE_THRESHOLD = 50;
  private readonly SWIPE_DURATION_THRESHOLD = 900;
  private readonly SWIPE_DIRECTION_RATIO = 1.2;
  private readonly SWIPE_MAX_Y = 80;
  private readonly EDGE_THRESHOLD = 30;
  
  constructor(
    private target: HTMLElement,
    private callbacks: {
      onSwipeRight?: () => void;  // Open sidebar
      onSwipeLeft?: () => void;   // Close sidebar
    }
  ) {
    this.bindEvents();
  }

  private bindEvents(): void {
    // Only bind on touch-capable devices
    if (!('ontouchstart' in window)) return;
    
    this.target.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: true });
    this.target.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: true });
    this.target.addEventListener('touchend', () => this.handleTouchEnd(), { passive: true });
    this.target.addEventListener('touchcancel', () => this.handleTouchCancel(), { passive: true });
  }

  private handleTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (!touch) return;
    
    this.startX = touch.clientX;
    this.startY = touch.clientY;
    this.currentX = touch.clientX;
    this.currentY = touch.clientY;
    this.startTime = Date.now();

    // Check if sidebar is open
    this.isSidebarOpenAtStart = this.target.querySelector('.sidebar')?.classList.contains('open') ?? false;
    
    // Only start tracking if:
    // 1. Touch starts within edge threshold (for opening sidebar)
    // 2. OR sidebar is already open (for closing sidebar)
    if (this.startX <= this.EDGE_THRESHOLD || this.isSidebarOpenAtStart) {
      this.isDragging = true;
    }
  }

  private handleTouchMove(e: TouchEvent): void {
    if (!this.isDragging) return;
    if (e.touches.length !== 1) return;
    
    const touch = e.touches[0];
    if (!touch) return;
    
    this.currentX = touch.clientX;
    this.currentY = touch.clientY;
  }

  private handleTouchEnd(): void {
    if (!this.isDragging) {
      return;
    }

    const deltaX = this.currentX - this.startX;
    const deltaXAbs = Math.abs(deltaX);
    const deltaY = Math.abs(this.currentY - this.startY);
    const elapsed = Date.now() - this.startTime;

    // Check if this is a valid horizontal swipe
    if (deltaXAbs > this.SWIPE_THRESHOLD && deltaY < this.SWIPE_MAX_Y && deltaXAbs > deltaY * this.SWIPE_DIRECTION_RATIO && elapsed < this.SWIPE_DURATION_THRESHOLD) {
      if (deltaX > 0 && !this.isSidebarOpenAtStart && this.callbacks.onSwipeRight) {
        // Swipe right - open sidebar
        this.callbacks.onSwipeRight();
      } else if (deltaX < 0 && this.isSidebarOpenAtStart && this.callbacks.onSwipeLeft) {
        // Swipe left - close sidebar
        this.callbacks.onSwipeLeft();
      }
    }
    
    this.isDragging = false;
    this.isSidebarOpenAtStart = false;
  }

  private handleTouchCancel(): void {
    this.isDragging = false;
    this.isSidebarOpenAtStart = false;
  }
  
  destroy(): void {
    // Event listeners will be automatically cleaned up when element is removed
    this.isDragging = false;
  }
}
