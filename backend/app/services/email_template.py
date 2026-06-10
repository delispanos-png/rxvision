"""Email-safe newsletter rendering.

Wraps the composer's content HTML into a responsive, email-client-safe document
(table layout, 600px, inline styles, hidden preheader, branded header + compliant
footer with unsubscribe). WYSIWYG editors output div/p HTML; email clients (Outlook,
Gmail) need this wrapper to render reliably. Also handles {{merge}} personalization.
"""

from __future__ import annotations

import html as _html

ACCENT = "#4f46e5"
BRAND = "RxVision"
COMPANY = "CloudOn"


def apply_merge_tags(content: str, *, name: str = "", pharmacy: str = "",
                     email: str = "", unsubscribe_url: str = "#") -> str:
    """Replace {{name}}, {{pharmacy}}, {{email}}, {{unsubscribe}} in the content."""
    repl = {
        "{{name}}": _html.escape(name or "συνεργάτη"),
        "{{pharmacy}}": _html.escape(pharmacy or ""),
        "{{email}}": _html.escape(email or ""),
        "{{unsubscribe}}": unsubscribe_url,
    }
    for k, v in repl.items():
        content = content.replace(k, v)
    return content


def render_newsletter(content_html: str, *, subject: str, preheader: str = "",
                      unsubscribe_url: str = "#", brand: str = BRAND,
                      accent: str = ACCENT) -> str:
    """Return a complete, responsive, email-safe HTML document."""
    pre = _html.escape(preheader or "")
    subj = _html.escape(subject or "")
    year = "2026"
    return f"""<!DOCTYPE html>
<html lang="el" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title>{subj}</title>
<style>
  @media only screen and (max-width:600px) {{
    .container {{ width:100% !important; }}
    .px {{ padding-left:20px !important; padding-right:20px !important; }}
  }}
  body {{ margin:0; padding:0; background:#f1f5f9; }}
  a {{ color:{accent}; }}
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
  <!-- preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
    {pre}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0"
             style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;
                    box-shadow:0 1px 3px rgba(16,24,40,.08);font-family:Helvetica,Arial,sans-serif;">
        <!-- header -->
        <tr><td style="background:{accent};padding:22px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">{brand}</span>
          <span style="color:#c7d2fe;font-size:12px;font-weight:600;">&nbsp;· Pharmacy Analytics</span>
        </td></tr>
        <!-- body -->
        <tr><td class="px" style="padding:32px;color:#0f172a;font-size:15px;line-height:1.6;">
          {content_html}
        </td></tr>
        <!-- footer -->
        <tr><td class="px" style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;
                 color:#94a3b8;font-size:12px;line-height:1.6;font-family:Helvetica,Arial,sans-serif;">
          <strong style="color:#64748b;">{_html.escape(COMPANY)}</strong> — {brand}<br/>
          Λάβατε αυτό το email ως συνεργαζόμενο φαρμακείο της πλατφόρμας.<br/>
          <a href="{unsubscribe_url}" style="color:#94a3b8;text-decoration:underline;">Διαγραφή από τη λίστα</a>
          &nbsp;·&nbsp; © {year} {_html.escape(COMPANY)}
        </td></tr>
      </table>
      <div style="color:#cbd5e1;font-size:11px;padding-top:14px;font-family:Helvetica,Arial,sans-serif;">
        {brand} · rxvision.gr
      </div>
    </td></tr>
  </table>
</body>
</html>"""


def render_transactional(*, title: str, body_html: str, cta_label: str | None = None,
                         cta_url: str | None = None, preheader: str = "",
                         brand: str = BRAND, accent: str = ACCENT) -> str:
    """Branded, responsive, email-safe wrapper for a SYSTEM/transactional email (welcome,
    password reset, notification). Rendering layer only — callers pass already-safe body HTML.
    Shares the newsletter shell (600px table, inline styles, hidden preheader, brand header)."""
    pre = _html.escape(preheader or title or "")
    subj = _html.escape(title or "")
    year = "2026"
    cta = ""
    if cta_label and cta_url:
        cta = (
            f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">'
            f'<tr><td style="border-radius:10px;background:{accent};">'
            f'<a href="{cta_url}" style="display:inline-block;padding:12px 28px;color:#ffffff;'
            f'font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;'
            f'text-decoration:none;border-radius:10px;">{_html.escape(cta_label)}</a>'
            f'</td></tr></table>'
        )
    return f"""<!DOCTYPE html>
<html lang="el" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title>{subj}</title>
<style>
  @media only screen and (max-width:600px) {{
    .container {{ width:100% !important; }}
    .px {{ padding-left:20px !important; padding-right:20px !important; }}
  }}
  body {{ margin:0; padding:0; background:#f1f5f9; }}
  a {{ color:{accent}; }}
</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">
    {pre}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0"
             style="width:600px;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;
                    box-shadow:0 1px 3px rgba(16,24,40,.08);font-family:Helvetica,Arial,sans-serif;">
        <tr><td style="background:{accent};padding:22px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.3px;">{brand}</span>
          <span style="color:#c7d2fe;font-size:12px;font-weight:600;">&nbsp;· Pharmacy Analytics</span>
        </td></tr>
        <tr><td class="px" style="padding:32px;color:#0f172a;font-size:15px;line-height:1.6;">
          <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0f172a;">{subj}</h1>
          {body_html}
          {cta}
        </td></tr>
        <tr><td class="px" style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;
                 color:#94a3b8;font-size:12px;line-height:1.6;font-family:Helvetica,Arial,sans-serif;">
          <strong style="color:#64748b;">{_html.escape(COMPANY)}</strong> — {brand}
          &nbsp;·&nbsp; © {year} {_html.escape(COMPANY)}
        </td></tr>
      </table>
      <div style="color:#cbd5e1;font-size:11px;padding-top:14px;font-family:Helvetica,Arial,sans-serif;">
        {brand} · rxvision.gr
      </div>
    </td></tr>
  </table>
</body>
</html>"""
