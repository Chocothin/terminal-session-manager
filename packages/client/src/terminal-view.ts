import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';

export class TerminalView {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private serializeAddon: SerializeAddon;
  private resizeObserver: ResizeObserver;
  private container: HTMLElement;
  private inputCallback: ((data: string) => void) | null = null;
  private resizeCallback: ((cols: number, rows: number) => void) | null = null;
  private isReadOnly = false;
  private itermMode = false;
  private itermCols = 0;
  private itermRows = 0;
  private itermOriginalFontSize = 14;
  private itermResizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private dimensionsDisposable: { dispose: () => void } | null = null;
  private pendingStreamData: string[] = [];
  private scrollLocked = false;
  private scrollUnlockRaf = 0;
  private touchGestureAccumulatedDelta = 0;
  private unlockConsecutiveCount = 0;
  private isFlushing = false;
  private pendingStreamBytes = 0;
  private readonly MAX_PENDING_BYTES = 524288; // 512KB
  private mobileInputBar: HTMLElement | null = null;
  private keyboardToggleBtn: HTMLButtonElement | null = null;
  private keyboardVisible = false;
  private iosInput: HTMLInputElement | null = null;
  private resizeDebounceTimer = 0;
  private mobileScrollWrapper: HTMLElement | null = null;
  private mobileScrollX = 0;
  private mobileScrollMaxX = 0;
  private mobileScrollTracking: 'none' | 'h' | 'v' = 'none';
  private mobileTouchStartX = 0;
  private mobileTouchStartY = 0;
  private mobileScrollStartX = 0;
  private mobileVelocity = 0;
  private mobileLastMoveX = 0;
  private mobileLastMoveTime = 0;
  private mobileMomentumId = 0;
  private copyToast: HTMLElement | null = null;
  private scrollBadge: HTMLElement | null = null;
  private linkHighlight: { url: string; absRow: number; overlay: HTMLElement } | null = null;
  private linkTapStartX = 0;
  private linkTapStartY = 0;
  private linkTapPreventFocus = false;
  
  private isIOS = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      },
    });

    this.fitAddon = new FitAddon();
    this.serializeAddon = new SerializeAddon();

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.serializeAddon);

    this.terminal.open(container);

    if (this.isMobile() && this.terminal.textarea) {
      this.terminal.textarea.addEventListener('focus', () => {
        if (this.linkTapPreventFocus) {
          this.linkTapPreventFocus = false;
          this.terminal.textarea?.blur();
        }
      });
    }

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        console.warn('WebGL context lost, falling back to canvas renderer');
        webglAddon.dispose();
      });
      this.terminal.loadAddon(webglAddon);
    } catch (error) {
      console.warn('WebGL addon failed to load, using canvas renderer:', error);
    }

    if (!this.isMobile() && !this.isIOS) {
      this.terminal.loadAddon(new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }));
    }

    this.terminal.onData((data) => {
      if (!this.isReadOnly && this.inputCallback && data) {
        if (this.isIOS) return;
        this.inputCallback(data);
      }
    });

    this.terminal.onResize(({ cols, rows }) => {
      if (this.resizeCallback) {
        this.resizeCallback(cols, rows);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.itermMode) {
        if (this.isMobile()) {
          this.refitMobileItermRows();
        } else {
          this.debouncedItermResize();
        }
      } else if (this.isMobile()) {
        clearTimeout(this.resizeDebounceTimer);
        this.resizeDebounceTimer = window.setTimeout(() => {
          this.fit();
          this.scrollToBottom();
        }, 250);
      } else {
        this.fit();
      }
    });
    this.resizeObserver.observe(container);

    this.setupScrollLock();
    this.configureIME();
    this.setupMobileInput();
    this.setupMobileLinkTap();
    this.createScrollBadge();
    this.fit();
    
    requestAnimationFrame(() => {
      this.scrollToBottom();
    });
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  writeStream(data: string): void {
    if (this.scrollLocked || this.isFlushing) {
      const dataBytes = data.length * 2;
      this.pendingStreamBytes += dataBytes;
      while (this.pendingStreamBytes > this.MAX_PENDING_BYTES && this.pendingStreamData.length > 0) {
        const dropped = this.pendingStreamData.shift()!;
        this.pendingStreamBytes -= dropped.length * 2;
      }
      this.pendingStreamData.push(data);
      this.showScrollBadge();
      return;
    }
    this.terminal.write(data);
  }

  onInput(callback: (data: string) => void): void {
    this.inputCallback = callback;
  }

  onResize(callback: (cols: number, rows: number) => void): void {
    this.resizeCallback = callback;
  }

  writeHistory(lines: string[]): void {
    if (lines.length === 0) return;
    for (const line of lines) {
      this.terminal.writeln(line);
    }
    this.terminal.write('\n'.repeat(this.terminal.rows));
    this.scrollToBottom();
  }

  scrollToBottom(): void {
    requestAnimationFrame(() => this.terminal.scrollToBottom());
  }

  resetView(): void {
    this.scrollLocked = false;
    this.unlockConsecutiveCount = 0;
    this.pendingStreamBytes = 0;
    this.hideScrollBadge();
    this.flushPendingStream();
    this.terminal.scrollToBottom();
    this.clearLinkHighlight();
    if (this.mobileScrollWrapper) {
      cancelAnimationFrame(this.mobileMomentumId);
      this.mobileScrollX = 0;
      this.container.style.transform = '';
    }
  }

  fit(): void {
    try {
      this.fitAddon.fit();
    } catch (error) {
      console.error('Failed to fit terminal:', error);
    }
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  serialize(): string {
    return this.serializeAddon.serialize();
  }

  clear(): void {
    this.terminal.clear();
  }

  focus(): void {
    this.terminal.focus();
  }

  blur(): void {
    this.terminal.blur();
  }

  setReadOnly(readonly: boolean): void {
    this.isReadOnly = readonly;
    if (readonly) {
      this.terminal.options.cursorBlink = false;
      this.terminal.options.cursorStyle = 'bar';
    } else {
      this.terminal.options.cursorBlink = true;
      this.terminal.options.cursorStyle = 'block';
    }
  }

  enterItermMode(cols: number, rows: number): void {
    this.itermMode = true;
    this.itermCols = cols;
    this.itermRows = rows;
    this.itermOriginalFontSize = this.terminal.options.fontSize ?? 14;

    if (this.isMobile()) {
      this.terminal.options.fontSize = 12;
      this.setupMobileItermWidth(cols, rows);
      return;
    }

    this.terminal.resize(cols, rows);

    const dims = (this.terminal as any).dimensions;
    if (dims?.css?.cell?.width) {
      this.applyItermFontScale();
    } else {
      setTimeout(() => {
        if (this.itermMode) {
          this.applyItermFontScale();
        }
      }, 100);
    }
  }

  exitItermMode(): void {
    this.itermMode = false;
    this.dimensionsDisposable?.dispose();
    this.dimensionsDisposable = null;
    if (this.itermResizeTimeout) {
      clearTimeout(this.itermResizeTimeout);
      this.itermResizeTimeout = null;
    }
    this.disableHorizontalScroll();
    this.clearItermMobileWidths();
    this.terminal.options.fontSize = this.itermOriginalFontSize;
    this.fit();
  }

  isInItermMode(): boolean {
    return this.itermMode;
  }

  private configureIME(): void {
    if (!this.isMobile() && !this.isIOS) return;

    const textarea = this.terminal.textarea;
    if (!textarea) return;

    this.container.addEventListener('touchend', (e) => {
      if (this.keyboardVisible && !this.isReadOnly) {
        const target = e.target as HTMLElement;
        if (!target.closest('.mobile-input-bar')) {
          if (this.isIOS && this.iosInput) {
            this.iosInput.blur();
          } else {
            textarea.blur();
          }
          this.keyboardVisible = false;
        }
      }
    }, { passive: true });

    textarea.addEventListener('focus', () => {
      this.keyboardVisible = true;
      this.adjustForKeyboard();
    });
    textarea.addEventListener('blur', () => {
      this.keyboardVisible = false;
      this.adjustForKeyboard();
    });

    if (window.visualViewport) {
      let resizeTimeout = 0;
      window.visualViewport.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = window.setTimeout(() => this.adjustForKeyboard(), 100);
      });
    }
  }

  private isMobile(): boolean {
    return window.innerWidth <= 768 || ('ontouchstart' in window && window.innerWidth <= 1024);
  }


  private setupMobileInput(): void {
    if (!this.isMobile() && !this.isIOS) return;

    this.mobileInputBar = document.createElement('div');
    this.mobileInputBar.className = 'mobile-input-bar';

    if (this.isIOS) {
      this.setupIOSInputBar();
    } else {
      this.setupDefaultInputBar();
    }

    this.insertMobileInputBar();
  }

  private iosInputMode = false;
  private iosFormEl: HTMLFormElement | null = null;
  private iosBtnBarEl: HTMLElement | null = null;
  private iosLastSyncedValue = '';

  private setupIOSInputBar(): void {
    if (!this.mobileInputBar) return;

    const form = document.createElement('form');
    form.className = 'ios-input-form';
    form.setAttribute('autocomplete', 'off');
    this.iosFormEl = form;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ios-main-input';
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.enterKeyHint = 'send';
    input.placeholder = 'Input...';
    this.iosInput = input;

    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'ios-send-btn';
    sendBtn.textContent = '↩';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ios-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.sendIOSInput();
      this.setIOSInputMode(false);
    });

    form.appendChild(input);
    form.appendChild(sendBtn);
    form.appendChild(closeBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendIOSInput();
      this.inputCallback?.('\r');
    });

    input.addEventListener('focus', () => {
      this.keyboardVisible = true;
      this.adjustForKeyboard();
    });
    input.addEventListener('blur', () => {
      this.keyboardVisible = false;
      this.adjustForKeyboard();
    });

    input.addEventListener('input', () => {
      if (this.isReadOnly || !this.inputCallback) return;
      const current = input.value;
      const prev = this.iosLastSyncedValue;
      if (current.startsWith(prev)) {
        // Characters appended — send the new suffix
        const added = current.slice(prev.length);
        if (added) this.inputCallback(added);
      } else {
        // Deletion or replacement — find common prefix length
        let commonLen = 0;
        while (commonLen < prev.length && commonLen < current.length && prev[commonLen] === current[commonLen]) {
          commonLen++;
        }
        const deletedCount = prev.length - commonLen;
        const addedSuffix = current.slice(commonLen);
        if (deletedCount > 0) this.inputCallback('\x7f'.repeat(deletedCount));
        if (addedSuffix) this.inputCallback(addedSuffix);
      }
      this.iosLastSyncedValue = current;
    });

    const btnGroup = document.createElement('div');
    btnGroup.className = 'ios-btn-bar';
    this.iosBtnBarEl = btnGroup;

    const kbBtn = document.createElement('button');
    kbBtn.type = 'button';
    kbBtn.className = 'ios-key-btn';
    kbBtn.textContent = '⌨';
    kbBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setIOSInputMode(true);
    });
    btnGroup.appendChild(kbBtn);

    const enterBtn = document.createElement('button');
    enterBtn.type = 'button';
    enterBtn.className = 'ios-key-btn ios-enter-btn';
    enterBtn.textContent = '↩';
    enterBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.inputCallback?.('\r');
    });
    btnGroup.appendChild(enterBtn);

    const specialKeys: Array<{ label: string; data: string }> = [
      { label: '⇥', data: '\t' },
      { label: '↑', data: '\x1b[A' },
      { label: '↓', data: '\x1b[B' },
      { label: 'esc', data: '\x1b' },
    ];

    for (const key of specialKeys) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ios-key-btn';
      btn.textContent = key.label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.inputCallback?.(key.data);
      });
      btnGroup.appendChild(btn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ios-key-btn';
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.copyTerminalContent();
    });
    btnGroup.appendChild(copyBtn);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'ios-key-btn reset-view-btn';
    resetBtn.textContent = '⇣';
    resetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetView();
    });
    btnGroup.appendChild(resetBtn);

    this.mobileInputBar.appendChild(form);
    this.mobileInputBar.appendChild(btnGroup);
    this.setIOSInputMode(false);
  }

  private setIOSInputMode(show: boolean): void {
    this.iosInputMode = show;
    if (this.iosFormEl) this.iosFormEl.style.display = show ? 'flex' : 'none';
    if (this.iosBtnBarEl) this.iosBtnBarEl.style.display = show ? 'none' : 'flex';
    if (show && this.iosInput) {
      requestAnimationFrame(() => this.iosInput?.focus());
    } else if (this.iosInput) {
      this.iosInput.blur();
    }
  }

  private sendIOSInput(): void {
    if (!this.iosInput || this.isReadOnly || !this.inputCallback) return;
    const current = this.iosInput.value;
    const unsynced = current.slice(this.iosLastSyncedValue.length);
    if (unsynced) {
      this.inputCallback(unsynced);
    }
    this.iosInput.value = '';
    this.iosLastSyncedValue = '';
  }

  private setupDefaultInputBar(): void {
    if (!this.mobileInputBar) return;

    this.keyboardToggleBtn = document.createElement('button');
    this.keyboardToggleBtn.className = 'mobile-kb-btn';
    this.keyboardToggleBtn.textContent = '⌨';
    this.keyboardToggleBtn.setAttribute('aria-label', 'Toggle keyboard');
    this.keyboardToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.keyboardVisible) {
        this.terminal.textarea?.blur();
        this.keyboardVisible = false;
      } else {
        this.terminal.focus();
        this.keyboardVisible = true;
      }
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mobile-kb-btn';
    copyBtn.textContent = '⎘';
    copyBtn.setAttribute('aria-label', 'Copy terminal content');
    copyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.copyTerminalContent();
    });

    const resetBtn = document.createElement('button');
    resetBtn.className = 'mobile-kb-btn reset-view-btn';
    resetBtn.textContent = '⇣';
    resetBtn.setAttribute('aria-label', 'Reset view');
    resetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetView();
    });

    this.mobileInputBar.appendChild(this.keyboardToggleBtn);
    this.mobileInputBar.appendChild(copyBtn);
    this.mobileInputBar.appendChild(resetBtn);
  }

  private adjustForKeyboard(): void {
    if (!this.isMobile() && !this.isIOS) return;
    if (this.itermMode) {
      this.refitMobileItermRows();
      this.scrollToBottom();
      return;
    }
    
    clearTimeout(this.resizeDebounceTimer);
    this.resizeDebounceTimer = window.setTimeout(() => {
      this.fit();
      this.scrollToBottom();
    }, 100);
  }

  private insertMobileInputBar(): void {
    if (!this.mobileInputBar) return;
    if (this.container.parentElement) {
      this.container.parentElement.insertBefore(
        this.mobileInputBar,
        this.container.nextSibling,
      );
      this.adjustForKeyboard();
    } else {
      requestAnimationFrame(() => this.insertMobileInputBar());
    }
  }

  enableHorizontalScroll(): void {
    this.container.classList.add('terminal-hscroll');
  }

  disableHorizontalScroll(): void {
    this.container.classList.remove('terminal-hscroll');
  }

  private flushPendingStream(): void {
    if (this.pendingStreamData.length === 0) return;
    this.isFlushing = true;
    const batch = this.pendingStreamData.join('');
    this.pendingStreamData = [];
    this.pendingStreamBytes = 0;
    const CHUNK_SIZE = 16384;
    if (batch.length <= CHUNK_SIZE) {
      this.terminal.write(batch);
      this.isFlushing = false;
      if (this.pendingStreamData.length > 0) {
        this.flushPendingStream();
      }
      return;
    }
    let offset = 0;
    const writeNextChunk = () => {
      if (offset >= batch.length) {
        this.isFlushing = false;
        if (this.pendingStreamData.length > 0) {
          this.flushPendingStream();
        }
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE, batch.length);
      this.terminal.write(batch.slice(offset, end));
      offset = end;
      if (offset < batch.length) {
        requestAnimationFrame(writeNextChunk);
      } else {
        this.isFlushing = false;
        if (this.pendingStreamData.length > 0) {
          this.flushPendingStream();
        }
      }
    };
    writeNextChunk();
  }

  private tryUnlockScroll(): void {
    if (!this.scrollLocked) return;
    const buf = this.terminal.buffer.active;
    if (buf.viewportY >= buf.baseY) {
      this.unlockConsecutiveCount++;
      if (this.unlockConsecutiveCount >= 2) {
        this.scrollLocked = false;
        this.unlockConsecutiveCount = 0;
        this.hideScrollBadge();
        this.flushPendingStream();
      }
    } else {
      this.unlockConsecutiveCount = 0;
    }
  }

  private scheduleTryUnlockScroll(): void {
    if (this.scrollUnlockRaf) return;
    this.scrollUnlockRaf = requestAnimationFrame(() => {
      this.scrollUnlockRaf = 0;
      this.tryUnlockScroll();
    });
  }

  private setupScrollLock(): void {
    this.container.addEventListener('wheel', (e) => {
      const buf = this.terminal.buffer.active;
      if (e.deltaY < 0 && buf.baseY > 0) {
        this.scrollLocked = true;
      }
    }, { passive: true });

    let touchStartY = 0;
    let touchMoveRaf = 0;
    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        this.touchGestureAccumulatedDelta = 0;
      }
    }, { passive: true });

    this.container.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      if (touchMoveRaf) return;
      touchMoveRaf = requestAnimationFrame(() => {
        touchMoveRaf = 0;
        const deltaY = touchStartY - currentY;
        if (deltaY < 0) {
          this.touchGestureAccumulatedDelta += Math.abs(deltaY);
        }
        touchStartY = currentY;
        const buf = this.terminal.buffer.active;
        if (this.touchGestureAccumulatedDelta > 15 && buf.baseY > 0) {
          this.scrollLocked = true;
        }
      });
    }, { passive: true });

    this.container.addEventListener('touchend', () => {
      this.touchGestureAccumulatedDelta = 0;
      if (!this.scrollLocked) return;
      this.scheduleTryUnlockScroll();
    }, { passive: true });

    const viewport = this.container.querySelector('.xterm-viewport');
    if (viewport) {
      viewport.addEventListener('scroll', () => this.scheduleTryUnlockScroll(), { passive: true });
    }
  }

  private debouncedItermResize(): void {
    if (this.itermResizeTimeout) {
      clearTimeout(this.itermResizeTimeout);
    }
    this.itermResizeTimeout = setTimeout(() => {
      this.itermResizeTimeout = null;
      this.applyItermFontScale();
    }, 50);
  }

  private applyItermFontScale(): void {
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    if (containerWidth === 0 || containerHeight === 0) return;

    const dims = (this.terminal as any).dimensions;
    if (!dims?.css?.cell?.width || !dims?.css?.cell?.height) {
      requestAnimationFrame(() => this.applyItermFontScale());
      return;
    }

    const currentFontSize = this.terminal.options.fontSize ?? 14;
    const cellWidth = dims.css.cell.width;
    const cellHeight = dims.css.cell.height;

    // On mobile, enforce a minimum readable font size so the terminal
    // overflows the container and becomes horizontally scrollable.
    const minFontSize = this.isMobile() ? 10 : 1;

    const widthRatio = containerWidth / (this.itermCols * cellWidth);
    const heightRatio = containerHeight / (this.itermRows * cellHeight);
    const scaleFactor = Math.min(widthRatio, heightRatio);

    const optimalFontSize = Math.max(minFontSize, Math.min(
      Math.floor(currentFontSize * scaleFactor),
      this.itermOriginalFontSize
    ));

    if (this.terminal.options.fontSize !== optimalFontSize) {
      this.terminal.options.fontSize = optimalFontSize;
    }
    this.terminal.resize(this.itermCols, this.itermRows);
  }

  private setupMobileItermWidth(cols: number, _rows: number): void {
    const fontSize = this.terminal.options.fontSize ?? 12;
    const measureCanvas = document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    if (!ctx) return;
    ctx.font = `${fontSize}px ${this.terminal.options.fontFamily}`;
    const cellWidth = ctx.measureText('W').width;
    const totalWidth = Math.ceil(cols * cellWidth) + 20;

    const parent = this.container.parentElement;
    if (parent && !this.mobileScrollWrapper) {
      const wrapper = document.createElement('div');
      wrapper.className = 'mobile-scroll-wrapper';
      wrapper.style.flex = '1';
      wrapper.style.minHeight = '0';
      wrapper.style.overflow = 'hidden';
      parent.insertBefore(wrapper, this.container);
      wrapper.appendChild(this.container);
      this.mobileScrollWrapper = wrapper;
      this.setupMobileHorizontalTouch(wrapper);
    }

    this.mobileScrollMaxX = Math.max(0, totalWidth - (this.mobileScrollWrapper?.clientWidth ?? 390));
    this.container.style.width = `${totalWidth}px`;
    this.container.style.minWidth = `${totalWidth}px`;
    this.container.style.height = '100%';
    this.container.style.overflowX = 'hidden';
    this.container.style.overflowY = 'visible';
    void this.container.offsetWidth;

    this.terminal.resize(cols, _rows);
    requestAnimationFrame(() => this.refitMobileItermRows());
  }

  private setupMobileHorizontalTouch(wrapper: HTMLElement): void {
    wrapper.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      cancelAnimationFrame(this.mobileMomentumId);
      this.mobileTouchStartX = e.touches[0].clientX;
      this.mobileTouchStartY = e.touches[0].clientY;
      this.mobileScrollStartX = this.mobileScrollX;
      this.mobileScrollTracking = 'none';
      this.mobileVelocity = 0;
      this.mobileLastMoveX = e.touches[0].clientX;
      this.mobileLastMoveTime = Date.now();
    }, { passive: true });

    wrapper.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const cx = e.touches[0].clientX;
      const cy = e.touches[0].clientY;
      const dx = this.mobileTouchStartX - cx;
      const dy = this.mobileTouchStartY - cy;

      if (this.mobileScrollTracking === 'none') {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
          this.mobileScrollTracking = 'h';
        } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) {
          this.mobileScrollTracking = 'v';
          return;
        } else {
          return;
        }
      }

      if (this.mobileScrollTracking === 'v') return;

      e.preventDefault();
      const now = Date.now();
      const dt = now - this.mobileLastMoveTime;
      if (dt > 0) {
        this.mobileVelocity = (this.mobileLastMoveX - cx) / dt;
      }
      this.mobileLastMoveX = cx;
      this.mobileLastMoveTime = now;

      const newX = Math.max(0, Math.min(this.mobileScrollMaxX, this.mobileScrollStartX + dx));
      this.mobileScrollX = newX;
      this.container.style.transform = `translateX(-${newX}px)`;
    }, { passive: false });

    wrapper.addEventListener('touchend', () => {
      if (this.mobileScrollTracking === 'h' && Math.abs(this.mobileVelocity) > 0.3) {
        this.startMomentumScroll();
      }
      this.mobileScrollTracking = 'none';
    }, { passive: true });
  }

  private startMomentumScroll(): void {
    let velocity = this.mobileVelocity * 16;
    const step = () => {
      velocity *= 0.95;
      if (Math.abs(velocity) < 0.5) return;
      this.mobileScrollX = Math.max(0, Math.min(this.mobileScrollMaxX, this.mobileScrollX + velocity));
      this.container.style.transform = `translateX(-${this.mobileScrollX}px)`;
      this.mobileMomentumId = requestAnimationFrame(step);
    };
    this.mobileMomentumId = requestAnimationFrame(step);
  }

  private refitMobileItermRows(): void {
    if (!this.itermMode || !this.isMobile()) return;
    const core = (this.terminal as any)._core;
    const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellHeight || cellHeight <= 0) return;
    const availableHeight = this.container.clientHeight;
    if (availableHeight <= 0) return;
    const fittedRows = Math.max(1, Math.floor(availableHeight / cellHeight));
    if (fittedRows !== this.terminal.rows) {
      this.terminal.resize(this.itermCols, fittedRows);
    }
  }

  private mobileItermStyleEl: HTMLStyleElement | null = null;

  private clearItermMobileWidths(): void {
    cancelAnimationFrame(this.mobileMomentumId);
    this.container.style.width = '';
    this.container.style.minWidth = '';
    this.container.style.height = '';
    this.container.style.overflowX = '';
    this.container.style.overflowY = '';
    this.container.style.transform = '';
    this.mobileScrollX = 0;
    this.mobileScrollMaxX = 0;
    if (this.mobileScrollWrapper) {
      const parent = this.mobileScrollWrapper.parentElement;
      if (parent) {
        parent.insertBefore(this.container, this.mobileScrollWrapper);
        this.mobileScrollWrapper.remove();
      }
      this.mobileScrollWrapper = null;
    }
    if (this.mobileItermStyleEl) {
      this.mobileItermStyleEl.remove();
      this.mobileItermStyleEl = null;
    }
  }

  copyTerminalContent(): void {
    let text = '';
    if (this.terminal.hasSelection()) {
      text = this.terminal.getSelection();
    } else {
      text = this.serializeAddon.serialize();
    }
    if (!text) return;

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this.showCopyToast(this.terminal.hasSelection() ? 'Copied selection' : 'Copied all'),
        () => this.fallbackCopy(text),
      );
    } else {
      this.fallbackCopy(text);
    }
  }

  private fallbackCopy(text: string): void {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    try {
      document.execCommand('copy');
      this.showCopyToast('Copied');
    } catch {
      this.showCopyToast('Copy failed');
    }
    document.body.removeChild(textarea);
  }

  private showCopyToast(message: string): void {
    if (this.copyToast) {
      this.copyToast.remove();
    }
    const toast = document.createElement('div');
    toast.className = 'copy-toast';
    toast.textContent = message;
    (this.mobileScrollWrapper ?? this.container.parentElement ?? this.container).appendChild(toast);
    this.copyToast = toast;
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => {
        toast.remove();
        if (this.copyToast === toast) this.copyToast = null;
      }, 200);
    }, 1200);
  }

  private createScrollBadge(): void {
    const badge = document.createElement('div');
    badge.className = 'scroll-badge';
    badge.textContent = '\u21e3 New output below';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetView();
    });
    badge.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetView();
    });
    this.scrollBadge = badge;
    // Insert into terminal parent container
    const parent = this.mobileScrollWrapper ?? this.container.parentElement ?? this.container;
    parent.appendChild(badge);
  }

  private showScrollBadge(): void {
    if (!this.scrollBadge || this.scrollBadge.classList.contains('visible')) return;
    this.scrollBadge.classList.add('visible');
  }

  private hideScrollBadge(): void {
    if (!this.scrollBadge) return;
    this.scrollBadge.classList.remove('visible');
  }

  private setupMobileLinkTap(): void {
    if (!this.isMobile() && !this.isIOS) return;

    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.linkTapStartX = e.touches[0].clientX;
        this.linkTapStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    this.container.addEventListener('touchend', (e) => {
      if (e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      if (Math.abs(t.clientX - this.linkTapStartX) > 10 || Math.abs(t.clientY - this.linkTapStartY) > 10) return;
      if (this.handleLinkTap(t.clientX, t.clientY)) {
        this.linkTapPreventFocus = true;
      }
    }, { passive: true });

    this.terminal.onScroll(() => this.clearLinkHighlight());
  }

  private handleLinkTap(clientX: number, clientY: number): boolean {
    const core = (this.terminal as any)._core;
    const cellW = core?._renderService?.dimensions?.css?.cell?.width;
    const cellH = core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellW || !cellH) return false;

    const screen = this.container.querySelector('.xterm-screen') as HTMLElement;
    if (!screen) return false;
    const rect = screen.getBoundingClientRect();

    const col = Math.floor((clientX - rect.left) / cellW);
    const row = Math.floor((clientY - rect.top) / cellH);
    if (row < 0 || row >= this.terminal.rows || col < 0) {
      this.clearLinkHighlight();
      return false;
    }

    const buffer = this.terminal.buffer.active;
    const absRow = buffer.viewportY + row;
    const line = buffer.getLine(absRow);
    if (!line) { this.clearLinkHighlight(); return false; }

    const text = line.translateToString();
    const urlRegex = /https?:\/\/[^\s<>"')\]},;]+/g;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      if (col >= match.index && col < match.index + match[0].length) {
        const url = match[0];

        const viewportEl = this.container.querySelector('.xterm-viewport') as HTMLElement;
        const savedScroll = viewportEl?.scrollTop ?? 0;
        const restoreScroll = () => {
          if (viewportEl) viewportEl.scrollTop = savedScroll;
        };
        requestAnimationFrame(restoreScroll);
        setTimeout(restoreScroll, 50);
        setTimeout(restoreScroll, 150);

        if (this.linkHighlight?.url === url && this.linkHighlight.absRow === absRow) {
          window.open(url, '_blank', 'noopener,noreferrer');
          this.clearLinkHighlight();
          return true;
        }

        this.clearLinkHighlight();
        const overlay = document.createElement('div');
        overlay.className = 'link-underline';
        overlay.style.left = `${match.index * cellW}px`;
        overlay.style.top = `${(row + 1) * cellH - 2}px`;
        overlay.style.width = `${match[0].length * cellW}px`;
        screen.appendChild(overlay);

        this.linkHighlight = { url, absRow, overlay };
        return true;
      }
    }

    this.clearLinkHighlight();
    return false;
  }

  private clearLinkHighlight(): void {
    if (this.linkHighlight) {
      this.linkHighlight.overlay.remove();
      this.linkHighlight = null;
    }
  }

  dispose(): void {
    this.clearLinkHighlight();
    this.resizeObserver.disconnect();
    this.dimensionsDisposable?.dispose();
    if (this.itermResizeTimeout) {
      clearTimeout(this.itermResizeTimeout);
    }
    this.clearItermMobileWidths();
    this.mobileInputBar?.remove();
    this.scrollBadge?.remove();
    this.terminal.dispose();
  }
}
