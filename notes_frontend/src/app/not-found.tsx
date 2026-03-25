import React from "react";

export default function NotFound() {
  return (
    <main className="nm-app">
      <header className="nm-card" style={{ margin: 12, padding: 14 }}>
        <div style={{ fontWeight: 800 }}>NoteMaster</div>
        <div style={{ fontSize: 13, color: "var(--nm-muted)" }}>Not Found</div>
      </header>

      <section className="nm-card" style={{ margin: 12, padding: 16 }} role="alert" aria-live="assertive">
        <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>404 – Page Not Found</h1>
        <p style={{ color: "var(--nm-muted)" }}>
          The page you’re looking for doesn’t exist.
        </p>
      </section>
    </main>
  );
}
