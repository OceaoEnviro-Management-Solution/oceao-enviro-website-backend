const queryClientConfirmationTemplate = ({ name, industry }) => {
    const text = `
    Hello ${name},

    Thank you for contacting OCEAO ENVIRO.

    We have successfully received your query regarding: ${industry}
    
    Our team will review your request and get back to you
    within the expected response timeframe.

    We appreciate your interest in OCEAO ENVIRO.

    Regards,
    OCEAO ENVIRO
    `.trim()

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>New Query Received</title>
    </head>
    <body>
        <p>Hello ${name},</p>
        <p>Thank you for contacting OCEAO ENVIRO.</p>
        <p>We have successfully received your query regarding: ${industry}</p>
        <p>Our team will review your request and get back to you within the expected response timeframe.</p>
        <p>We appreciate your interest in OCEAO ENVIRO.</p>
        <p>Regards,</p>
        <p>OCEAO ENVIRO</p>
    </body>
    </html>
    `.trim()

    return {
        text,
        html,
        subject: `QUERY: We Have Received Your Request`
    }
}

export { queryClientConfirmationTemplate };
