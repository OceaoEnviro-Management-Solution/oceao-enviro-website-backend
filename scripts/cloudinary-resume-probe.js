// Checks, with your real Cloudinary account, that resumes can be stored privately and downloaded
// through a signed link, exactly as the Apply form and the admin dashboard do it:
//
//   npm run careers:probe
//
//   1. uploads a tiny generated PDF as a PRIVATE raw file in oceao/resumes
//   2. checks that the file has no public link (the plain delivery URL must not serve it)
//   3. prints the signed download link (valid 5 minutes), downloads it and prints the HTTP status and size
//   4. deletes the file again
//
// Needs the CLOUDINARY_* values in .env. The API secret is never printed. If the download is not
// HTTP 200, "Allow delivery of PDF and ZIP files" is usually off (Cloudinary console: Settings > Security).

import "dotenv/config";

import { config } from "../src/config/env.js";
import { RESUME_FOLDER, deleteResume, getResumeDownloadUrl, uploadResume } from "../src/services/cloudinary.service.js";

// A valid one-page PDF with the text "Oceao Enviro resume probe".
const probePdf = () => {
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        null,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    const stream = "BT /F1 14 Tf 20 70 Td (Oceao Enviro resume probe) Tj ET";
    objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

    let pdf = "%PDF-1.4\n";
    const offsets = [];
    objects.forEach((body, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
};

const status = async (url) => {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const body = Buffer.from(await response.arrayBuffer());
        return { status: response.status, bytes: body.length, body, type: response.headers.get("content-type") };
    } catch (error) {
        return { status: `request failed (${error?.cause?.code ?? error?.name ?? "error"})`, bytes: 0, body: Buffer.alloc(0) };
    }
};

const main = async () => {
    const pdf = probePdf();
    const name = `PROBE-${Date.now()}`;
    console.log(`1. Uploading a ${pdf.length}-byte PDF as a private raw file in ${RESUME_FOLDER} ...`);
    const { publicId, bytes } = await uploadResume(pdf, name, "pdf");
    console.log(`   stored as "${publicId}" (${bytes} bytes)`);

    let downloadOk = false;
    try {
        const publicUrl = `https://res.cloudinary.com/${encodeURIComponent(config.CLOUDINARY_CLOUD_NAME)}/raw/upload/${publicId}`;
        const open = await status(publicUrl);
        console.log(`2. Plain public link: HTTP ${open.status} -> ${open.status === 200 ? "PROBLEM: the file is public" : "not served (private, as it should be)"}`);

        const signed = getResumeDownloadUrl(publicId);
        console.log("3. Signed download link (works for 5 minutes):");
        console.log(`   ${signed}`);
        const download = await status(signed);
        const isPdf = download.body.subarray(0, 5).toString("latin1") === "%PDF-";
        console.log(`   download: HTTP ${download.status}, ${download.bytes} bytes, content-type ${download.type ?? "-"}, ${isPdf ? "the same PDF came back" : "NOT the PDF"}`);
        downloadOk = download.status === 200 && isPdf && download.bytes === pdf.length;
    } finally {
        await deleteResume(publicId);
        console.log(`4. Deleted "${publicId}" again.`);
    }

    if (downloadOk) {
        console.log("\nRESULT: OK. Private upload, signed download (HTTP 200) and delete all work.");
    } else {
        console.log("\nRESULT: the download did NOT return HTTP 200 with the file. Check \"Allow delivery of PDF and ZIP files\" in the Cloudinary console (Settings > Security).");
        process.exitCode = 1;
    }
};

main().catch((error) => {
    console.error(`\ncareers-probe failed: ${error.message}`);
    process.exit(1);
});
