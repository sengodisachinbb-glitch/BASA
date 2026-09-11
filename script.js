/**
 * Main JavaScript for High-Performance Physics-Based UI Interactions
 */

// 1. INITIALIZATION & FEATURE DETECTION
const isTouchDevice = window.matchMedia('(hover: none)').matches;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Cache ALL DOM elements
const navbar = document.getElementById('navbar');
const mobileMenuButton = document.getElementById('mobileMenuButton');
const mobileMenu = document.getElementById('mobileMenu');
const navLinks = document.querySelectorAll('.desktop-nav a');
const sections = document.querySelectorAll('section[id]');
const buttons = document.querySelectorAll('.button');
const featureCards = document.querySelectorAll('.feature-card');
const revealElements = document.querySelectorAll('[data-reveal], .reveal');
const heroObject = document.querySelector('.hero-object');
const glassElements = document.querySelectorAll('.glass-subtle, .glass-standard, .glass-premium, .glass-floating');
const prismElements = document.querySelectorAll('[data-prism]');
const tiltElements = document.querySelectorAll('[data-tilt]');
const magneticElements = document.querySelectorAll('.magnetic');
const innerDepthLayers = document.querySelectorAll('.glass-inner-depth');

// 2. UTILITY FUNCTIONS
function lerp(start, end, factor) {
  return start + (end - start) * factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function angleBetween(cx, cy, px, py) {
  return Math.atan2(py - cy, px - cx) * (180 / Math.PI);
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  return clamp((value - inMin) / (inMax - inMin) * (outMax - outMin) + outMin, outMin, outMax);
}

// 3. MOUSE STATE TRACKING
const mouse = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  lastX: window.innerWidth / 2,
  lastY: window.innerHeight / 2,
  velocity: 0,
  smoothVelocity: 0,
  lastMoveTime: performance.now(),
  moving: false
};

if (!isTouchDevice && !prefersReducedMotion) {
  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    const dt = now - mouse.lastMoveTime || 16.66;
    
    mouse.lastX = mouse.x;
    mouse.lastY = mouse.y;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    
    const dx = mouse.x - mouse.lastX;
    const dy = mouse.y - mouse.lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    mouse.velocity = clamp(dist / dt, 0, 5); // Limit max velocity
    mouse.lastMoveTime = now;
    mouse.moving = true;
  }, { passive: true });
}

// 4. GLASS LIGHT TRACKING + PRISMATIC + NEW DEPTH EFFECTS
function updateGlassElements() {
  glassElements.forEach(element => {
    const rect = element.getBoundingClientRect();
    
    // Only process elements visible in viewport
    if (rect.top > window.innerHeight || rect.bottom < 0) return;
    
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Light coordinates as percentage
    const x = ((mouse.x - rect.left) / rect.width) * 100;
    const y = ((mouse.y - rect.top) / rect.height) * 100;
    
    element.style.setProperty('--light-x', `${x}%`);
    element.style.setProperty('--light-y', `${y}%`);
    
    // Depth calculations
    const dist = distance(centerX, centerY, mouse.x, mouse.y);
    const maxDist = Math.max(rect.width, rect.height);
    const proximity = 1 - clamp(dist / maxDist, 0, 1);
    
    element.style.setProperty('--cursor-proximity', proximity.toFixed(3));
    
    const specular = clamp(proximity * 0.7 + mouse.smoothVelocity * 0.3, 0, 1);
    element.style.setProperty('--specular-intensity', specular.toFixed(3));
    
    const innerLayer = element.querySelector('.glass-inner-depth');
    if (innerLayer) {
      const offsetX = (mouse.x - centerX) * 0.08; 
      const offsetY = (mouse.y - centerY) * 0.08;
      innerLayer.style.setProperty('--parallax-x', `${offsetX}px`);
      innerLayer.style.setProperty('--parallax-y', `${offsetY}px`);
    }
  });

  prismElements.forEach(element => {
    const rect = element.getBoundingClientRect();
    if (rect.top > window.innerHeight || rect.bottom < 0) return;
    
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const angle = angleBetween(centerX, centerY, mouse.x, mouse.y);
    
    element.style.setProperty('--prism-angle', `${angle}deg`);
    
    // Set light position on prism elements for conic-gradient origin
    const px = ((mouse.x - rect.left) / rect.width) * 100;
    const py = ((mouse.y - rect.top) / rect.height) * 100;
    element.style.setProperty('--light-x', `${px}%`);
    element.style.setProperty('--light-y', `${py}%`);
    
    // Prism intensity based on velocity AND proximity
    // Stronger when cursor is close AND moving fast
    const dist = distance(centerX, centerY, mouse.x, mouse.y);
    const maxDist = Math.sqrt(rect.width ** 2 + rect.height ** 2) / 2;
    const proximity = 1 - clamp(dist / (maxDist * 1.5), 0, 1);
    const intensity = clamp(mouse.smoothVelocity * proximity * 2.5, 0, 1);
    element.style.setProperty('--prism-opacity', intensity.toFixed(3));
  });
}

// 5. HERO PARALLAX
function updateHeroParallax() {
  if (!heroObject) return;
  const rect = heroObject.getBoundingClientRect();
  if (rect.bottom < 0) return;
  
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const offsetX = (mouse.x - cx) / cx;
  const offsetY = (mouse.y - cy) / cy;
  
  heroObject.style.setProperty('--mouse-x', `${offsetX * 25}px`);
  heroObject.style.setProperty('--mouse-y', `${offsetY * 25}px`);
}

// 6. MAIN ANIMATION LOOP
function animate() {
  if (prefersReducedMotion) {
    requestAnimationFrame(animate);
    return;
  }
  const timeSinceMove = performance.now() - mouse.lastMoveTime;
  if (timeSinceMove > 50) {
    mouse.velocity *= 0.92;
  }
  mouse.smoothVelocity = lerp(mouse.smoothVelocity, mouse.velocity, 0.08);
  
  updateGlassElements();
  updateHeroParallax();
  
  requestAnimationFrame(animate);
}

// 7. 3D TILT
if (!isTouchDevice && !prefersReducedMotion) {
  tiltElements.forEach(element => {
    element.addEventListener('mousemove', (e) => {
      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      const rotateX = ((y - centerY) / centerY) * -5;
      const rotateY = ((x - centerX) / centerX) * 5;
      
      element.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(8px)`;
      element.style.transition = 'transform 0.1s ease-out';
    }, { passive: true });
    
    element.addEventListener('mouseleave', () => {
      element.style.transform = `perspective(800px) rotateX(0deg) rotateY(0deg) translateZ(0px)`;
      element.style.transition = 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';
    }, { passive: true });
  });
}

// 8. MAGNETIC BUTTONS
if (!isTouchDevice && !prefersReducedMotion) {
  magneticElements.forEach(element => {
    element.addEventListener('mousemove', (e) => {
      const rect = element.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      
      element.style.transform = `translate(${x * 0.1}px, ${y * 0.1}px)`;
      element.style.transition = 'transform 0.1s ease-out';
    }, { passive: true });
    
    element.addEventListener('mouseleave', () => {
      element.style.transform = 'translate(0px, 0px)';
      element.style.transition = 'transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';
    }, { passive: true });
  });
}

// 9. NAVBAR SCROLL
window.addEventListener('scroll', () => {
  if (window.scrollY > 50) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}, { passive: true });

// 10. MOBILE MENU
if (mobileMenuButton && mobileMenu) {
  mobileMenuButton.addEventListener('click', () => {
    const isExpanded = mobileMenuButton.getAttribute('aria-expanded') === 'true';
    mobileMenuButton.setAttribute('aria-expanded', !isExpanded);
    mobileMenu.classList.toggle('open');
  });

  const mobileNavLinks = mobileMenu.querySelectorAll('a');
  mobileNavLinks.forEach(link => {
    link.addEventListener('click', () => {
      mobileMenuButton.setAttribute('aria-expanded', 'false');
      mobileMenu.classList.remove('open');
    });
  });
}

// 11. SCROLL REVEAL
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, {
  threshold: 0.12,
  rootMargin: '0px 0px -50px 0px'
});

revealElements.forEach(element => {
  revealObserver.observe(element);
});

// Auto-stagger feature cards
const cardsArray = Array.from(featureCards);
cardsArray.forEach((card, index) => {
  card.style.setProperty('--reveal-delay', `${index * 0.1}s`);
});

// 12. ACTIVE NAV
const navObserverOptions = {
  rootMargin: '-20% 0px -80% 0px'
};

const navObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.getAttribute('id');
      navLinks.forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('href') === `#${id}`) {
          link.classList.add('active');
        }
      });
    }
  });
}, navObserverOptions);

sections.forEach(section => {
  navObserver.observe(section);
});

// 13. BUTTON PRESS
buttons.forEach(button => {
  button.addEventListener('mousedown', () => {
    button.style.transform = 'scale(0.95)';
  }, { passive: true });
  
  button.addEventListener('mouseup', () => {
    button.style.transform = 'scale(1)';
  }, { passive: true });
  
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'scale(1)';
  }, { passive: true });
  
  button.addEventListener('touchstart', () => {
    button.style.transform = 'scale(0.95)';
  }, { passive: true });
  
  button.addEventListener('touchend', () => {
    button.style.transform = 'scale(1)';
  }, { passive: true });
});

// 14. SCROLL-BASED DEPTH
const depthObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const ratio = entry.intersectionRatio;
      const scale = mapRange(ratio, 0, 1, 0.985, 1);
      entry.target.style.setProperty('--scroll-scale', scale.toFixed(4));
    }
  });
}, {
  threshold: Array.from({ length: 20 }, (_, i) => i / 19),
  rootMargin: '0px'
});

glassElements.forEach(el => {
  if (el.classList.contains('glass-standard') || el.classList.contains('glass-premium')) {
    depthObserver.observe(el);
  }
});

// 15. START ANIMATION LOOP
if (!isTouchDevice && !prefersReducedMotion) {
  requestAnimationFrame(animate);
}

// Initial check for navbar
if (window.scrollY > 50) {
  navbar?.classList.add('scrolled');
}