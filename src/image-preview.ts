export interface ImageLinkSpan {
  row: number;
  startCol: number;
  endCol: number; // inclusive
}

export interface DetectedTerminalLink {
  rawUrl: string;
  url: string;
  imageUrl: string | null;
  isImage: boolean;
  domain: string;
  spans: ImageLinkSpan[];
}

export type DetectedImageLink = DetectedTerminalLink;

const URL_CANDIDATE_REGEX =
  /https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;%=]+/gi;

/**
 * Normalizes detected URLs into direct image URLs.
 * Handles Imgur, X/Twitter, direct extensions, etc.
 */
export function normalizeImageUrl(rawUrl: string): string | null {
  // Strip trailing punctuation that might have been typed right after the URL
  const cleanUrl = rawUrl.replace(/[.,)\]>，。）」]+$/, '');

  // Imgur: page or image link -> direct image URL
  const imgurMatch = cleanUrl.match(
    /^https?:\/\/(?:i\.)?imgur\.com\/([a-zA-Z0-9]+)(?:\.([a-zA-Z0-9]+))?(?:\?.*)?$/i
  );
  if (imgurMatch) {
    const id = imgurMatch[1];
    const ext = imgurMatch[2]?.toLowerCase();
    const reserved = [
      'a',
      'gallery',
      'signin',
      'register',
      't',
      'upload',
      'account',
      'about',
    ];
    if (reserved.includes(id.toLowerCase())) {
      return null;
    }
    if (ext === 'gifv' || !ext) {
      return `https://i.imgur.com/${id}.jpg`;
    }
    return `https://i.imgur.com/${id}.${ext}`;
  }

  // Check for common image extensions
  const isImageExt = /\.(?:jpg|jpeg|png|gif|webp)(?:\?.*)?$/i.test(cleanUrl);

  // Check for image hosting domains without standard extensions
  const isImageHost =
    cleanUrl.includes('pbs.twimg.com/media/') ||
    cleanUrl.includes('upload.cc/') ||
    cleanUrl.includes('images.plurk.com/');

  if (isImageExt || isImageHost) {
    return cleanUrl;
  }

  return null;
}

function extractDomain(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

/**
 * Scans the 24 lines of the terminal screen and detects all web URLs,
 * including single-line and wrapped (across 2 lines) BBS links.
 */
export function extractTerminalLinksFromScreen(
  screenLines: string[]
): DetectedTerminalLink[] {
  const links: DetectedTerminalLink[] = [];

  for (let r = 0; r < screenLines.length; r++) {
    const line = screenLines[r];
    URL_CANDIDATE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = URL_CANDIDATE_REGEX.exec(line)) !== null) {
      const rawMatch = match[0];
      const startCol = match.index;
      const endCol = startCol + rawMatch.length - 1;

      // Check if this URL wraps onto the next line (common in BBS when URL reaches right margin)
      let isWrapped = false;
      let fullRaw = rawMatch;
      let nextSpan: ImageLinkSpan | null = null;

      if (r + 1 < screenLines.length && endCol >= 72) {
        const nextLine = screenLines[r + 1];
        const nextMatch = nextLine.match(/^[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;%=]+/);
        if (nextMatch) {
          fullRaw = rawMatch + nextMatch[0];
          isWrapped = true;
          nextSpan = {
            row: r + 1,
            startCol: 0,
            endCol: nextMatch[0].length - 1,
          };
        }
      }

      const cleanUrl = fullRaw.replace(/[.,)\]>，。）」]+$/, '');
      if (cleanUrl.length <= 10) continue;

      const imageUrl = normalizeImageUrl(cleanUrl);
      const spans: ImageLinkSpan[] = [{ row: r, startCol, endCol }];
      if (isWrapped && nextSpan) {
        spans.push(nextSpan);
      }

      links.push({
        rawUrl: fullRaw,
        url: cleanUrl,
        imageUrl,
        isImage: imageUrl !== null,
        domain: extractDomain(cleanUrl),
        spans,
      });
    }
  }

  return links;
}

export const extractImageLinksFromScreen = extractTerminalLinksFromScreen;

/**
 * Finds if a cell at (col, row) is part of any detected image link.
 */
export function findLinkAtCell(
  links: DetectedImageLink[],
  col: number,
  row: number
): DetectedImageLink | null {
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    for (let j = 0; j < link.spans.length; j++) {
      const span = link.spans[j];
      if (span.row === row && col >= span.startCol && col <= span.endCol) {
        return link;
      }
    }
  }
  return null;
}

/**
 * Overlay controller for hover preview popovers and full lightbox modals.
 */
export class ImagePreviewOverlay {
  private readonly container: HTMLElement;
  private readonly hoverPopover: HTMLElement;
  private readonly hoverImg: HTMLImageElement;
  private readonly hoverDomain: HTMLElement;
  private readonly hoverHint: HTMLElement;
  private readonly hoverUrlText: HTMLElement;

  private readonly lightboxModal: HTMLElement;
  private readonly lightboxImg: HTMLImageElement;
  private readonly lightboxUrlText: HTMLElement;
  private readonly lightboxCounter: HTMLElement;
  private readonly lightboxPrevBtn: HTMLButtonElement;
  private readonly lightboxNextBtn: HTMLButtonElement;
  private readonly lightboxOpenBtn: HTMLAnchorElement;
  private readonly lightboxCopyBtn: HTMLButtonElement;
  private readonly lightboxSpinner: HTMLElement;

  private activeHoverLink: DetectedTerminalLink | null = null;
  private lastAllLinks: DetectedTerminalLink[] = [];
  private currentLinks: DetectedTerminalLink[] = [];
  private currentIndex = 0;
  private loadCounter = 0;
  private hoverHideTimeout: number | null = null;
  private isModalOpen = false;

  constructor(container: HTMLElement, private readonly onClose?: () => void) {
    this.container = container;

    // 1. Build Hover Popover
    this.hoverPopover = document.createElement('div');
    this.hoverPopover.className = 'image-hover-popover';
    this.hoverPopover.innerHTML = `
      <div class="popover-header">
        <span class="popover-badge" id="popoverDomain">link</span>
        <span class="popover-hint" id="popoverHint">Click to open ↗</span>
      </div>
      <div class="popover-body">
        <div class="popover-url" id="popoverUrl"></div>
        <img class="popover-img" id="popoverImg" referrerpolicy="no-referrer" alt="Preview" />
      </div>
    `;
    this.container.appendChild(this.hoverPopover);

    this.hoverImg = this.hoverPopover.querySelector(
      '#popoverImg'
    ) as HTMLImageElement;
    this.hoverDomain = this.hoverPopover.querySelector(
      '#popoverDomain'
    ) as HTMLElement;
    this.hoverHint = this.hoverPopover.querySelector(
      '#popoverHint'
    ) as HTMLElement;
    this.hoverUrlText = this.hoverPopover.querySelector(
      '#popoverUrl'
    ) as HTMLElement;

    // 2. Build Lightbox Modal
    this.lightboxModal = document.createElement('div');
    this.lightboxModal.className = 'image-lightbox-modal';
    this.lightboxModal.innerHTML = `
      <div class="lightbox-backdrop"></div>
      <div class="lightbox-dialog">
        <div class="lightbox-header">
          <div class="lightbox-title-wrap">
            <span class="lightbox-counter" id="lightboxCounter">1 / 1</span>
            <div class="lightbox-title" id="lightboxUrlText">Image Preview</div>
          </div>
          <div class="lightbox-actions">
            <button class="lightbox-btn" id="lightboxCopyBtn" title="Copy URL">Copy URL</button>
            <a class="lightbox-btn primary" id="lightboxOpenBtn" target="_blank" rel="noopener noreferrer">Open Original ↗</a>
            <button class="lightbox-close" id="lightboxCloseBtn" title="Close (Esc)">✕</button>
          </div>
        </div>
        <div class="lightbox-body">
          <button class="lightbox-nav-btn prev" id="lightboxPrevBtn" title="Previous Image (← or A)">❮</button>
          <div class="lightbox-content">
            <div class="lightbox-spinner" id="lightboxSpinner" style="display: none;"></div>
            <img class="lightbox-img" id="lightboxImg" referrerpolicy="no-referrer" alt="Full Image" />
          </div>
          <button class="lightbox-nav-btn next" id="lightboxNextBtn" title="Next Image (→ or D)">❯</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.lightboxModal);

    this.lightboxImg = this.lightboxModal.querySelector(
      '#lightboxImg'
    ) as HTMLImageElement;
    this.lightboxUrlText = this.lightboxModal.querySelector(
      '#lightboxUrlText'
    ) as HTMLElement;
    this.lightboxCounter = this.lightboxModal.querySelector(
      '#lightboxCounter'
    ) as HTMLElement;
    this.lightboxPrevBtn = this.lightboxModal.querySelector(
      '#lightboxPrevBtn'
    ) as HTMLButtonElement;
    this.lightboxNextBtn = this.lightboxModal.querySelector(
      '#lightboxNextBtn'
    ) as HTMLButtonElement;
    this.lightboxOpenBtn = this.lightboxModal.querySelector(
      '#lightboxOpenBtn'
    ) as HTMLAnchorElement;
    this.lightboxCopyBtn = this.lightboxModal.querySelector(
      '#lightboxCopyBtn'
    ) as HTMLButtonElement;
    this.lightboxSpinner = this.lightboxModal.querySelector(
      '#lightboxSpinner'
    ) as HTMLElement;

    this.bindEvents();
  }

  private bindEvents(): void {
    // Lightbox close interactions
    const closeBtn = this.lightboxModal.querySelector('#lightboxCloseBtn');
    closeBtn?.addEventListener('click', () => this.closeLightbox());

    const backdrop = this.lightboxModal.querySelector('.lightbox-backdrop');
    backdrop?.addEventListener('click', () => this.closeLightbox());

    this.lightboxPrevBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.showPrevImage();
    });

    this.lightboxNextBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      this.showNextImage();
    });

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!this.isModalOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeLightbox();
        return;
      }

      if (
        e.key === 'ArrowLeft' ||
        e.key === 'a' ||
        e.key === 'A' ||
        e.key === 'p' ||
        e.key === 'P'
      ) {
        e.preventDefault();
        this.showPrevImage();
        return;
      }

      if (
        e.key === 'ArrowRight' ||
        e.key === 'd' ||
        e.key === 'D' ||
        e.key === 'n' ||
        e.key === 'N'
      ) {
        e.preventDefault();
        this.showNextImage();
        return;
      }
    });

    this.lightboxCopyBtn.addEventListener('click', async () => {
      if (!this.lightboxOpenBtn.href) return;
      try {
        await navigator.clipboard.writeText(this.lightboxOpenBtn.href);
        const originalText = this.lightboxCopyBtn.textContent;
        this.lightboxCopyBtn.textContent = 'Copied!';
        setTimeout(() => {
          this.lightboxCopyBtn.textContent = originalText;
        }, 1500);
      } catch (err) {
        console.error('Failed to copy image URL:', err);
      }
    });

    // Clicking the hover popover: opens lightbox if image, or navigates to URL
    this.hoverPopover.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      if (!this.activeHoverLink) return;
      if (this.activeHoverLink.isImage) {
        this.openLightbox(this.activeHoverLink, this.lastAllLinks);
      } else {
        window.open(this.activeHoverLink.url, '_blank', 'noopener,noreferrer');
        this.hideHover(true);
      }
    });
  }

  public showHover(
    link: DetectedTerminalLink,
    clientX: number,
    clientY: number,
    allLinks?: DetectedTerminalLink[]
  ): void {
    if (this.isModalOpen) return;
    this.lastAllLinks = allLinks && allLinks.length > 0 ? allLinks : [link];

    if (this.hoverHideTimeout !== null) {
      window.clearTimeout(this.hoverHideTimeout);
      this.hoverHideTimeout = null;
    }

    if (this.activeHoverLink?.rawUrl !== link.rawUrl) {
      this.activeHoverLink = link;
      this.hoverDomain.textContent = link.domain;

      if (link.isImage && link.imageUrl) {
        this.hoverImg.style.display = 'block';
        this.hoverUrlText.style.display = 'none';
        this.hoverHint.textContent = 'Click to view · Ctrl+Click to open ↗';
        this.hoverImg.src = link.imageUrl;
      } else {
        this.hoverImg.style.display = 'none';
        this.hoverUrlText.style.display = 'block';
        this.hoverUrlText.textContent = link.url;
        this.hoverHint.textContent = 'Click to open in new tab ↗';
      }
    }

    const containerRect = this.container.getBoundingClientRect();
    const relX = clientX - containerRect.left;
    const relY = clientY - containerRect.top;

    // Position preview slightly offset from cursor
    let popoverX = relX + 16;
    let popoverY = relY + 16;

    // Flip horizontally or vertically if overflowing container boundaries
    const popoverW = 260;
    const popoverH = link.isImage ? 220 : 100;

    if (popoverX + popoverW > containerRect.width) {
      popoverX = Math.max(8, relX - popoverW - 16);
    }
    if (popoverY + popoverH > containerRect.height) {
      popoverY = Math.max(8, relY - popoverH - 16);
    }

    this.hoverPopover.style.left = `${popoverX}px`;
    this.hoverPopover.style.top = `${popoverY}px`;
    this.hoverPopover.style.display = 'flex';
  }

  public hideHover(immediate = false): void {
    if (immediate) {
      if (this.hoverHideTimeout !== null) {
        window.clearTimeout(this.hoverHideTimeout);
        this.hoverHideTimeout = null;
      }
      this.hoverPopover.style.display = 'none';
      this.activeHoverLink = null;
      return;
    }

    if (this.hoverHideTimeout === null) {
      this.hoverHideTimeout = window.setTimeout(() => {
        this.hoverPopover.style.display = 'none';
        this.activeHoverLink = null;
        this.hoverHideTimeout = null;
      }, 180);
    }
  }

  public openLightbox(
    link: DetectedTerminalLink,
    allLinks?: DetectedTerminalLink[]
  ): void {
    if (!link.isImage || !link.imageUrl) {
      window.open(link.url, '_blank', 'noopener,noreferrer');
      return;
    }

    this.hideHover(true);
    this.isModalOpen = true;

    // Deduplicate image links by normalized imageUrl
    const imageLinks = (allLinks || [link]).filter(
      (l) => l.isImage && l.imageUrl !== null
    );

    const seen = new Set<string>();
    const deduped: DetectedTerminalLink[] = [];
    for (const item of imageLinks) {
      if (!seen.has(item.imageUrl!)) {
        seen.add(item.imageUrl!);
        deduped.push(item);
      }
    }
    this.currentLinks = deduped.length > 0 ? deduped : [link];

    const foundIdx = this.currentLinks.findIndex(
      (l) => l.imageUrl === link.imageUrl
    );
    if (foundIdx >= 0) {
      this.currentIndex = foundIdx;
    } else {
      this.currentLinks.unshift(link);
      this.currentIndex = 0;
    }

    this.updateCurrentImage();
    this.lightboxModal.style.display = 'flex';
  }

  public showNextImage(): void {
    if (this.currentLinks.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.currentLinks.length;
    this.updateCurrentImage();
  }

  public showPrevImage(): void {
    if (this.currentLinks.length <= 1) return;
    this.currentIndex =
      (this.currentIndex - 1 + this.currentLinks.length) %
      this.currentLinks.length;
    this.updateCurrentImage();
  }

  private updateCurrentImage(): void {
    if (this.currentLinks.length === 0) return;
    const link = this.currentLinks[this.currentIndex];
    const imgUrl = link.imageUrl || link.url;

    this.lightboxUrlText.textContent = link.rawUrl;
    this.lightboxOpenBtn.href = imgUrl;

    const hasMultiple = this.currentLinks.length > 1;
    this.lightboxCounter.textContent = `${this.currentIndex + 1} / ${this.currentLinks.length}`;
    this.lightboxCounter.style.display = hasMultiple ? 'inline-block' : 'none';
    this.lightboxPrevBtn.style.display = hasMultiple ? 'flex' : 'none';
    this.lightboxNextBtn.style.display = hasMultiple ? 'flex' : 'none';

    const token = ++this.loadCounter;
    this.lightboxSpinner.style.display = 'none';

    // Keep previous image dimly visible to prevent layout flash while next image loads
    if (this.lightboxImg.src) {
      this.lightboxImg.style.opacity = '0.35';
    } else {
      this.lightboxImg.style.opacity = '0';
    }

    const preloader = new Image();
    preloader.referrerPolicy = 'no-referrer';
    preloader.src = imgUrl;

    const handleLoaded = (success: boolean) => {
      if (this.loadCounter !== token) return;
      if (success) {
        this.lightboxSpinner.style.display = 'none';
        this.lightboxImg.src = imgUrl;
        this.lightboxImg.style.opacity = '1';
      } else {
        this.lightboxSpinner.textContent = 'Failed to load image';
        this.lightboxSpinner.style.display = 'block';
        this.lightboxImg.style.opacity = '0';
      }
    };

    if (preloader.complete && preloader.naturalWidth > 0) {
      handleLoaded(true);
    } else {
      preloader.onload = () => handleLoaded(true);
      preloader.onerror = () => handleLoaded(false);
    }
  }

  public closeLightbox(): void {
    if (!this.isModalOpen) return;
    this.isModalOpen = false;
    this.lightboxModal.style.display = 'none';
    this.lightboxSpinner.style.display = 'none';
    this.lightboxImg.src = '';
    this.lightboxImg.style.opacity = '1';
    this.onClose?.();
  }

  public isLightboxOpen(): boolean {
    return this.isModalOpen;
  }

  public destroy(): void {
    this.hoverPopover.remove();
    this.lightboxModal.remove();
  }
}
