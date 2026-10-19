import type { Metadata } from "next";
import Link from "next/link";
import { ContactBlock, LegalPage } from "@/components/marketing/Legal";

export const metadata: Metadata = {
  title: "How we use AI",
  description: "What Atrium's AI enhancement changes in a walkthrough, what it never does, how it's labelled, and what happens to your data.",
};

// Keep this in step with worker/remaster (docs/remaster.md): the models listed are the ones it runs.

export default function AiUse() {
  return (
    <LegalPage
      title="How we use AI"
      intro={
        <>
          Atrium can rebuild a scanned home&apos;s 3D model with AI so the walkthrough looks sharper and more even. Here&apos;s exactly what that changes, what
          it never does, how buyers can tell, and what happens to your data.
        </>
      }
    >
      <h2>The original scan and the AI-enhanced model</h2>
      <p>
        Every walkthrough starts as the <strong>original scan</strong>: the 3D model the iPhone builds from its LiDAR measurements, painted with the photos it
        took. When an agent turns on AI enhancement, a cloud GPU builds a second version, the <strong>AI-enhanced model</strong>, from all of the scan&apos;s
        photos at once. The original is always kept. The agent compares the two and chooses which one buyers see.
      </p>

      <h2>What AI enhancement does</h2>
      <ul>
        <li>
          <strong>Sharpens blurry photos</strong> before they&apos;re used (NAFNet).
        </li>
        <li>
          <strong>Measures depth in the photos</strong> to correct the shapes of walls and furniture where the scan was rough (Prompt Depth Anything, guided by
          the phone&apos;s LiDAR).
        </li>
        <li>
          <strong>Separates objects</strong> such as furniture in the photos (SAM 2) and, where it matches the photos better than the scan,{" "}
          <strong>reshapes furniture</strong> from them (TripoSG).
        </li>
        <li>
          <strong>Repaints surfaces</strong> from every photo that saw them, evening out color and exposure between photos.
        </li>
        <li>
          <strong>Evens out the lighting</strong> across the whole home: takes most of the color cast of bulbs and window light out of the walls, brightens dim
          rooms toward daylight, and softens blown-out windows and lamps. One adjustment for the whole home — it doesn&apos;t add light sources, change shadows
          or relight individual rooms.
        </li>
        <li>
          <strong>Fills in small areas no photo saw</strong> — behind furniture, high corners — with plausible surface texture (LaMa). These areas are
          generated, not photographed.
        </li>
        <li>
          <strong>Tidies details:</strong> shows TVs switched off, brightens windows that came out dark, and sets doors and windows into their walls.
        </li>
        <li>
          <strong>Checks its own work:</strong> an AI vision model (Claude, by Anthropic) compares the model with the photos, removes scan debris it finds (such
          as bits the scanner caught of someone walking by), and has damaged furniture rebuilt — box-shaped pieces such as dressers as the box the scan
          measured, painted from the photos. Problems it still sees are listed for the agent.
        </li>
      </ul>

      <h2>What it never does</h2>
      <ul>
        <li>It doesn&apos;t add, remove or restyle furniture, fixtures or finishes (no virtual staging or renovation).</li>
        <li>It doesn&apos;t change the size or layout of rooms: those come from the LiDAR scan, in both versions.</li>
        <li>It doesn&apos;t replace the views out of windows or what&apos;s outside (dark windows may be brightened).</li>
        <li>It doesn&apos;t make decisions about people: it isn&apos;t used to evaluate buyers, renters or anyone else.</li>
      </ul>

      <h2>How it&apos;s labelled</h2>
      <p>
        Whenever a walkthrough shows the AI-enhanced model, it carries an <strong>AI-enhanced</strong> label next to the address, linking to this page. In the
        agent&apos;s preview, a switch shows the <strong>Original</strong> and <strong>AI-enhanced</strong> versions side by side. Agents should also follow
        their MLS&apos;s and regulators&apos; rules on disclosing enhanced images in listings.
      </p>

      <h2>People in photos</h2>
      <p>
        The iPhone app detects people in the photos it takes, and those parts of the photos are left out when walkthroughs are built, so people aren&apos;t
        painted into a home. The few photos sent to Claude to check the result aren&apos;t edited; it&apos;s told to ignore people and pets and judge only the
        model.
      </p>

      <h2>Your data</h2>
      <ul>
        <li>
          The models are built by open AI models on Atrium&apos;s own cloud GPUs (provided by Modal). To check the result, a few of the scan&apos;s photos and
          views of the model are sent to Anthropic&apos;s Claude API, which processes them for us under its commercial terms and doesn&apos;t train its models
          on them. No other third-party AI service sees your photos or scans.
        </li>
        <li>Your scans are used only to build your own walkthroughs. We don&apos;t use them to train AI models for anyone else.</li>
        <li>
          The photos kept for AI enhancement can be deleted from the listing&apos;s page at any time; see the <Link href="/legal/privacy">Privacy Policy</Link>{" "}
          for how long everything is kept.
        </li>
      </ul>

      <h2>Accuracy</h2>
      <p>
        AI-enhanced models are reconstructions and can contain mistakes — a smudged texture, a filled-in patch that doesn&apos;t match the real surface. Room
        sizes and measurements are approximate in both versions. If something looks wrong in a walkthrough, tell the agent or write to us.
      </p>

      <h2>Questions</h2>
      <ContactBlock />
    </LegalPage>
  );
}
