import { LegalPage } from "@/components/SiteChrome";

export const metadata = { title: "Terms" };

export default function Terms() {
  return (
    <LegalPage title="Terms of use">
      <p>By using CapClip you agree to the following. Operators should adapt these terms to their deployment.</p>
      <h2>Your content, your responsibility</h2>
      <p>Only process videos you own or are licensed to edit and redistribute. A public YouTube link does not grant permission to download or re-publish a video. You are responsible for respecting copyright and the terms of the platforms you publish to.</p>
      <h2>Platform rules</h2>
      <p>CapClip will not bypass access controls, DRM, age restrictions, private or members-only settings, or other platform safeguards. Direct retrieval from YouTube is only available where the operator has enabled it, and only after you confirm your rights.</p>
      <h2>AI output</h2>
      <p>Clip selections, captions, titles and descriptions are generated automatically and may contain errors. Review them before publishing. Engagement estimates are ranking signals only, not a promise of views or performance.</p>
      <h2>Availability</h2>
      <p>The service is provided as is. Processing limits (file size, video length) are set by the operator and shown in the app.</p>
    </LegalPage>
  );
}
