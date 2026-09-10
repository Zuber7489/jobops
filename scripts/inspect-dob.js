const { chromium } = require('playwright');

async function main() {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = b.contexts()[0]?.pages() || [];
  const p = pages.find(x => x.url().includes('270726018113')) || pages[0];
  console.log('Target tab:', p.url());

  const drawerData = await p.evaluate(() => {
    const d = document.querySelector('.chatbot_Drawer, [class*="chatbot_Drawer"]');
    if (!d) return 'No drawer';
    const msgs = Array.from(d.querySelectorAll('*')).filter(el => (el.innerText || '').trim().toLowerCase().includes('date of birth')).map(el => ({
      tag: el.tagName,
      className: el.className,
      html: el.outerHTML
    }));

    const inputs = Array.from(d.querySelectorAll('input, textarea, [contenteditable="true"], div')).filter(el => el.getAttribute('placeholder') || el.isContentEditable || (el.className && el.className.includes && (el.className.includes('input') || el.className.includes('textArea')))).map(el => ({
      tag: el.tagName,
      className: el.className,
      placeholder: el.getAttribute('placeholder'),
      isEditable: el.isContentEditable
    }));

    const buttons = Array.from(d.querySelectorAll('button, .btn, [class*="btn"], [class*="Save"]')).map(el => ({
      text: el.innerText,
      className: el.className
    }));

    return { msgs, inputs, buttons };
  });

  console.log(JSON.stringify(drawerData, null, 2));
}

main().catch(console.error);
