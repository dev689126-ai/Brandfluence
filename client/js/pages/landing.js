import { auth } from '../api.js';
import { $ } from '../ui.js';
import { playDemo } from '../motion.js';
import { platformMark } from '../icons.js';

export function renderLanding() {
  const stops = ['Offer', 'Signed', 'Paid in', 'Approved', 'Paid out'];
  const fc = (cls, init, name, handle, plat, n) => `<div class="float-card ${cls}" aria-hidden="true"><span class="avatar">${init}</span><div><b>${name}</b><span class="muted">${platformMark(plat)} ${handle} · ${n}</span></div></div>`;
  $('#app').innerHTML = `
  <div class="landing">
    <nav class="land-nav">
      <a class="brand" href="#"><i></i>Brandfluence</a>
      <div class="btn-row"><button class="btn secondary small" id="login2" style="background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.22)">Sign in</button></div>
    </nav>
    <section class="land-hero">
      <div>
        <h1>Brand deals with creators, from first offer to final payout.</h1>
        <p class="lead">Brands find the right creators and agree terms in one place. Money is held safely until the content is approved, so creators always get paid for work that's signed off.</p>
        <div class="btn-row">
          <button class="btn" id="signup">Create free account</button>
          <button class="btn secondary" id="login">Sign in</button>
        </div>
        <div class="land-proof">
          <div><b>0%</b>fee for creators</div>
          <div><b>7 days</b>to automatic payout</div>
          <div><b>100%</b>payment held safely</div>
        </div>
      </div>
      <div class="stage">
        ${fc('f1', 'PS', 'Priya Sharma', '@priyafitness', 'instagram', '2.4L')}
        ${fc('f2', 'RT', 'Rahul Tech', '@rahultech', 'youtube', '11L')}
        ${fc('f3', 'AK', 'Ananya Kitchen', '@ananyacooks', 'instagram', '86K')}
        <div class="demo-deal">
          <div class="small" style="color:#B8AECB">Deal DL-4K9Q · Summer launch</div>
          <h2 style="color:#fff;margin:6px 0 2px">2 Reels + 3 Stories</h2>
          <div style="color:#CFC6DF">Urban Watch Co. with @priyafitness</div>
          <div class="journey" id="demo-rail">${stops.map((s) => `<div class="stop shown"><div class="dot"></div>${s}</div>`).join('')}</div>
          <div class="demo-status" id="demo-status" aria-live="off"></div>
          <table class="lines" id="demo-lines">
            <tr><td>2 Instagram Reels</td><td>₹36,000</td></tr>
            <tr><td>3 Instagram Stories</td><td>₹6,000</td></tr>
            <tr><td>30-day usage rights</td><td>₹8,000</td></tr>
            <tr class="total"><td><span class="held">Held safely until approval</span><span class="paid-label">Paid to the creator</span></td><td>₹50,000</td></tr>
          </table>
        </div>
      </div>
    </section>
    <section class="land-how">
      <h2>How a deal works</h2>
      <p>The same four steps every time, for both sides.</p>
      <div class="how-grid">
        <div class="how-step"><span class="n">1</span><h3>Find and offer</h3><p>Brands filter creators by audience, engagement and price, then send an offer.</p></div>
        <div class="how-step"><span class="n">2</span><h3>Agree and sign</h3><p>Counter until the price is right. Both sides sign the agreement online.</p></div>
        <div class="how-step"><span class="n">3</span><h3>Pay in, create</h3><p>The brand pays in and the money is held. The creator uploads drafts for approval.</p></div>
        <div class="how-step"><span class="n">4</span><h3>Go live, get paid</h3><p>Once content is approved and live, the creator is paid, and both leave a review.</p></div>
      </div>
    </section>
  </div>`;
  playDemo($('#demo-rail'), $('#demo-status'), $('#demo-lines'));
  $('#signup').onclick = auth.signup;
  $('#login').onclick = auth.login;
  $('#login2').onclick = auth.login;
}
