import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';

const BASE_URL = 'https://amazoniavertical.wixsite.com/geovias';
const OUTPUT_DIR = path.join(process.cwd(), 'output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');

// Setup dirs
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

function urlToPath(urlStr) {
  let relative = urlStr.replace(BASE_URL, '').split('?')[0].split('#')[0];
  if (relative === '' || relative === '/') relative = 'home';
  if (relative.startsWith('/')) relative = relative.substring(1);
  return relative.replace(/[^a-zA-Z0-9-]/g, '_');
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

const downloadedImages = new Set();
async function downloadImage(url) {
  if (!url || url.startsWith('data:')) return;
  const hash = md5(url);
  const extMatch = url.match(/\.(jpg|jpeg|png|webp|gif)/i);
  const ext = extMatch ? extMatch[0] : '.jpg';
  const filename = `${hash}${ext}`;
  const filepath = path.join(IMAGES_DIR, filename);
  
  if (downloadedImages.has(hash)) return hash;
  downloadedImages.add(hash);
  
  if (fs.existsSync(filepath)) return hash;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`Baixada imagem: ${filename}`);
  } catch (err) {
    console.error(`Erro ao baixar imagem (${url}):`, err.message);
  }
  return hash;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const queue = [BASE_URL];
  const visited = new Set();

  while (queue.length > 0) {
    const currentUrl = queue.shift();
    // Normalize URL
    const normalizedUrl = currentUrl.split('?')[0].split('#')[0];
    
    if (visited.has(normalizedUrl)) continue;
    visited.add(normalizedUrl);

    console.log(`\nAcessando: ${normalizedUrl}`);
    const pageName = urlToPath(normalizedUrl);
    
    try {
      await page.goto(normalizedUrl, { waitUntil: 'load', timeout: 60000 });
      
      // Wait a bit and scroll down to trigger lazy loading
      console.log('Rolando página para carregar imagens...');
      let previousHeight = 0;
      for (let i = 0; i < 15; i++) {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await page.waitForTimeout(1000);
        const newHeight = await page.evaluate('document.body.scrollHeight');
        if (newHeight === previousHeight) break;
        previousHeight = newHeight;
      }
      
      // Additional wait to let images render
      await page.waitForTimeout(3000);
      
      // 1. Screenshot
      const screenshotPath = path.join(OUTPUT_DIR, `${pageName}_screenshot.jpg`);
      await page.screenshot({ path: screenshotPath, fullPage: true, type: 'jpeg', quality: 90 });
      console.log(`Screenshot salva: ${pageName}_screenshot.jpg`);

      // 2. HTML
      const html = await page.content();
      fs.writeFileSync(path.join(OUTPUT_DIR, `${pageName}_raw.html`), html);
      
      // 3. Text
      const text = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync(path.join(OUTPUT_DIR, `${pageName}_text.txt`), text);

      // 4. Extract Images
      const imagesUrls = await page.evaluate(() => {
        const urls = new Set();
        // img tags
        document.querySelectorAll('img').forEach(img => {
          if (img.src) urls.add(img.src);
        });
        // backgrounds
        document.querySelectorAll('*').forEach(el => {
          const bg = window.getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none' && bg.startsWith('url(')) {
            const cleanUrl = bg.slice(4, -1).replace(/["']/g, "");
            if (cleanUrl) urls.add(cleanUrl);
          }
        });
        return Array.from(urls);
      });
      
      for (const imgUrl of imagesUrls) {
        await downloadImage(imgUrl);
      }
      
      console.log(`Encontradas ${imagesUrls.length} referências de imagens (muitas podem já estar baixadas).`);

      // 5. Find links to add to queue
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a'))
          .map(a => a.href)
          .filter(href => href && href.startsWith('https://amazoniavertical.wixsite.com/geovias'));
      });
      
      for (const link of links) {
        const normalized = link.split('?')[0].split('#')[0];
        if (!visited.has(normalized) && !queue.includes(normalized)) {
          queue.push(normalized);
        }
      }

    } catch (err) {
      console.error(`Erro ao processar a página ${normalizedUrl}:`, err);
    }
  }

  await browser.close();
  console.log('\nScraping concluído! Todos os dados e imagens foram salvos.');
}

scrape().catch(console.error);
