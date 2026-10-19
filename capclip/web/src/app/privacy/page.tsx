import { LegalPage } from "@/components/SiteChrome";

export const metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy">
      <p>This page describes how this CapClip installation handles your data. Operators should review it and adapt it to their own deployment and jurisdiction.</p>
      <h2>What we store</h2>
      <p>The videos you upload (or that you ask the server to retrieve), the transcripts, frame analysis and edits derived from them, the clips you render, and your preferences. Your workspace is identified by a secure session cookie.</p>
      <h2>How media is protected</h2>
      <p>Files are stored privately on the server and never served at a guessable address. Every preview and download goes through a signed link that expires.</p>
      <h2>Third-party processing</h2>
      <p>If the operator configures cloud providers, transcripts and a small number of downscaled frames may be sent to them (for example Anthropic for clip selection, or OpenAI for transcription). No API keys are ever exposed to your browser.</p>
      <h2>Retention and deletion</h2>
      <p>Projects are deleted automatically after the retention period in your settings. Export archives are removed after 7 days. You can delete individual projects, or all your data, at any time from Settings.</p>
    </LegalPage>
  );
}
