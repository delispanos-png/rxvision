"""Email render-layer tests (no backend send involved)."""

from __future__ import annotations

from app.services.email_template import apply_merge_tags, render_newsletter, render_transactional


def test_apply_merge_tags_replaces_and_escapes():
    out = apply_merge_tags("Γεια {{name}} <{{email}}>", name="Α<x>", email="a@b.gr",
                           unsubscribe_url="https://x/u")
    assert "{{name}}" not in out and "{{email}}" not in out
    assert "Α&lt;x&gt;" in out          # HTML-escaped
    assert "a@b.gr" in out
    assert "συνεργάτη" in apply_merge_tags("{{name}}")   # default when empty


def test_render_newsletter_is_responsive_and_email_safe():
    html = render_newsletter("<p>Δοκιμή</p>", subject="Θέμα", preheader="προεπισκόπηση",
                             unsubscribe_url="https://x/unsub")
    assert html.startswith("<!DOCTYPE html>")
    assert 'lang="el"' in html
    assert "width=device-width" in html and "max-width:600px" in html   # responsive
    assert "<p>Δοκιμή</p>" in html                                       # body embedded
    assert "https://x/unsub" in html                                     # unsubscribe link


def test_render_transactional_with_and_without_cta():
    with_cta = render_transactional(title="Καλώς ήρθατε", body_html="<p>κείμενο</p>",
                                    cta_label="Σύνδεση", cta_url="https://app.rxvision.gr/login")
    assert "Καλώς ήρθατε" in with_cta and "<p>κείμενο</p>" in with_cta
    assert "https://app.rxvision.gr/login" in with_cta and "Σύνδεση" in with_cta
    assert "max-width:600px" in with_cta                                 # responsive
    without = render_transactional(title="X", body_html="<p>y</p>")
    assert "Σύνδεση" not in without and "<p>y</p>" in without            # CTA omitted cleanly
