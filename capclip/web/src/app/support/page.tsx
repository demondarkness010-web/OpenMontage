import Link from "next/link";
import { LegalPage } from "@/components/SiteChrome";

export const metadata = { title: "Support" };

export default function Support() {
  return (
    <LegalPage title="Support">
      <p>Most issues can be fixed from inside the app.</p>
      <h2>Processing failed or got stuck</h2>
      <p>Open the project and choose <b>Retry</b>. Finished steps such as transcription are reused, so a retry is faster than the first run. The <Link className="text-violet-2 underline" href="/app/queue">processing queue</Link> shows every job, its attempts and the last error.</p>
      <h2>&ldquo;Upload the file to continue&rdquo;</h2>
      <p>This server doesn&apos;t download from YouTube, so it needs the video file for that link. Upload a copy you have the rights to and processing starts automatically.</p>
      <h2>A clip is cut in the wrong place</h2>
      <p>Open it in the editor. Drag the start and end handles on the timeline, click a word to cut or keep it, and click a pause marker to restore it. Then choose <b>Save &amp; render</b>.</p>
      <h2>Features show as unavailable</h2>
      <p>Settings → System lists every capability and what the server needs for it, such as an API key for AI selection or FFmpeg with libass for captions.</p>
    </LegalPage>
  );
}
