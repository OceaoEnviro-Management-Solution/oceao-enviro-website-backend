const queryCompanyNotificationTemplate = ({ name, email, mobileNumber, industry, source, organisation, subject, query }) => {
    const text = `
        NEW QUERY RECEIVED

        CLIENT DETAILS
        Name: ${name}
        Mobile Number: ${mobileNumber}
        Organisation: ${organisation || "-"}
        Industry: ${industry || "-"}
        Source: ${source || "-"}
        Reply to: ${email}

        QUERY
        ${subject}

        ${query}

        ACTION
        Please review the query and follow up with the client as appropriate.

        Automated notification from OCEAO ENVIRO.
        `.trim();


    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>New Query Received</title>
</head>

<body>

    <h2><u>NEW QUERY RECEIVED</u></h2>

    <h3><b><i>CLIENT DETAILS</i></b></h3>
    <table>
        <tr>
            <td style="margin-right: 2px;">Name:</td>
            <td><strong>${name}</strong></td>
        </tr>
        <tr>
            <td style="margin-right: 2px;">Mobile Number:</td>
            <td><strong>${mobileNumber}</strong></td>
        </tr>
        <tr>
            <td style="margin-right: 2px;">Organisation:</td>
            <td><strong>${organisation || "-"}</strong></td>
        </tr>
        <tr>
            <td style="margin-right: 2px;">Industry:</td>
            <td><strong>${industry || "-"}</strong></td>
        </tr>
        <tr>
            <td style="margin-right: 2px;">Source:</td>
            <td><strong>${source || "-"}</strong></td>
        </tr>
        <tr>
            <td style="margin-right: 2px;">Reply to:</td>
            <td><a href="mailto:${email}"><strong>${email}</strong></a></td>
        </tr>
    </table>
    <hr>

    <h3 style="margin-top: 15px; margin-bottom: 5px;"><b><i>QUERY</i></b></h3>

    <p style="margin-top: 5px; margin-bottom: 5px;">
        <strong>Subject:${subject}</strong>
    </p>

    <p style="white-space: pre-line; margin-top: 5px; margin-bottom: 5px;">
        ${query}
    </p>

    <hr>
    <h3 style="margin-top: 15px; margin-bottom: 5px;"><b><i>ACTION</i></b></h3>

    <p>
        Please review the query and follow up with the client as appropriate.
    </p>

    <hr>

    <p>
        Automated notification from OCEAO ENVIRO.
    </p>

</body>
</html>
`.trim();

    return {
        text,
        html,
        subject: `QUERY: ${subject}`
    }
};

export { queryCompanyNotificationTemplate };
