import "dotenv/config";
import { handleNewQueryService } from "../src/services/query.services.js";
const testQuery = {
    name: "Rahul Kumar",
    email: "crazyheadtesla2@gmail.com",
    mobileNumber: "9876543210",
    organisation: "ABC Pvt Ltd",
    industry: "Environmental Consulting",
    source: "Google",
    subject: "Environmental Audit",
    query: `Hello,

I would like to know more about your environmental audit services.

Please let me know the process and
    approximate cost.

Regards,
Rahul`
};

try {

    const result = await handleNewQueryService(testQuery);

    console.log("TEST RESULT:");
    console.log(result);

} catch (error) {

    console.error("TEST FAILED:");
    console.error(error);

}