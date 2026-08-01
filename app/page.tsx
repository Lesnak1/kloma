const safeguards = [
  "Varsayılan dry-run; live mod açıkça etkinleştirilir",
  "Aktif round ve admission kapısı",
  "İki yönlü maker ücretinden sonra edge kontrolü",
  "Upstash distributed lock ve kalıcı telemetri",
  "Envanter, nakit, exposure ve drawdown limitleri",
  "Her emir için yeni nonce; write çağrılarında retry yok",
  "Round sonunda cancel-all ve scheduler shutdown",
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="eyebrow"><span className="pulse" /> LEAGUE EXECUTION ENGINE</div>
        <h1>Edge’i ara.<br /><em>Riski yaşat.</em></h1>
        <p className="lede">
          Loaf Markets testnet yarışması için fee-aware, çoklu piyasa ve leaderboard duyarlı işlem motoru.
          Hesap verileri ve operasyon endpointleri Bearer secret arkasındadır.
        </p>
        <div className="mode-row">
          <div><span className="label">DEFAULT</span><strong>DRY RUN</strong></div>
          <div><span className="label">HEARTBEAT</span><strong>1 MIN / CRON-JOB.ORG</strong></div>
          <div><span className="label">STATE</span><strong>UPSTASH REDIS</strong></div>
        </div>
      </section>

      <section className="grid">
        <article className="card thesis">
          <span className="number">01</span>
          <h2>Hybrid alpha</h2>
          <p>Microprice, book imbalance, EMA momentum, realized volatility ve referans fiyat sapması tek rezervasyon fiyatında birleşir.</p>
        </article>
        <article className="card">
          <span className="number">02</span>
          <h2>Adaptive edge</h2>
          <p>4–10 dakikalık forward edge, iki maker ücreti sonrasında ölçülür. Zayıf sinyal otomatik olarak daha küçük size ve daha yüksek eşik alır.</p>
        </article>
        <article className="card">
          <span className="number">03</span>
          <h2>Survival first</h2>
          <p>Leaderboard rejimi riski ayarlar; hard exposure, cash reserve ve drawdown limitleri hiçbir modda gevşemez.</p>
        </article>
      </section>

      <section className="safety">
        <div>
          <span className="eyebrow">NON-NEGOTIABLES</span>
          <h2>Bot önce hayatta kalır.</h2>
        </div>
        <ul>
          {safeguards.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>

      <footer>
        <span>LOAF LEAGUE TRADER / v1.1</span>
        <span>NO PROFIT GUARANTEE · TESTNET ONLY</span>
      </footer>
    </main>
  );
}
