import { Link, useNavigate } from "react-router-dom"

export function NotFound() {
  const navigate = useNavigate()

  return (
    <main className="not-found">
      <section className="not-found__card">
        <p className="not-found__eyebrow">Nothing to see here</p>
        <p className="not-found__code">404</p>
        <h1>Page not found</h1>
        <p className="not-found__description">
          The page you're looking for doesn't exist or may have been moved. Double-check the address
          or head back to the editor.
        </p>

        <div className="not-found__actions">
          <button type="button" className="not-found__button not-found__button--ghost" onClick={() => navigate(-1)}>
            Go back
          </button>
          <Link to="/" className="not-found__button not-found__button--ghost">
            Return to Home
          </Link>
        </div>
      </section>
    </main>
  )
}