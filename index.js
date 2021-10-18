const dotenv = require("dotenv");
const replace = require("replace-in-file");
const { exec } = require("child_process");
const fs = require("fs");
const axios = require("axios").default;
const FormData = require("form-data");
const {
  getIntrospectionQuery,
  buildClientSchema,
  printSchema,
} = require("graphql/utilities");
const path = require("path");
const stepzen = require("@stepzen/sdk");

dotenv.config();

const {
  APIGEE_TEMPLATE_ZIP,
  APIGEE_PROXYNAME,
  APIGEE_BASEPATH,
  APIGEE_ORG,
  APIGEE_TOKEN,
  STEPZEN_ADMINKEY,
  STEPZEN_APIKEY,
  STEPZEN_ACCOUNT,
  STEPZEN_HOST, // defaults to stepzen
  STEPZEN_FOLDER, // defaults to api
  STEPZEN_MODEL,
  STEPZEN_CONFIGFILE, // optional no default value
  STEPZEN_SCHEMADIR, // defaults to stepzen
} = process.env;

// validate
if (
  ![STEPZEN_ADMINKEY, STEPZEN_APIKEY, STEPZEN_ACCOUNT, STEPZEN_MODEL].every(
    (element) => element
  )
) {
  throw "StepZen not configured well, STEPZEN_ADMINKEY, STEPZEN_APIKEY, STEPZEN_ACCOUNT, and STEPZEN_MODEL are all required";
}

// validate
if (
  ![
    APIGEE_TEMPLATE_ZIP,
    APIGEE_ORG,
    APIGEE_PROXYNAME,
    APIGEE_BASEPATH,
    APIGEE_TOKEN,
  ].every((element) => element)
) {
  throw "Apigee not configured well, APIGEE_TEMPLATE_ZIP, APIGEE_ORG, APIGEE_PROXYNAME, APIGEE_TOKEN and APIGEE_BASEPATH are all required";
}

try {
  run();
} catch (e) {
  console.log(e);
}

async function run() {
  // Establish the StepZen variables needed.
  const stepzen_bundle = {
    adminkey: STEPZEN_ADMINKEY,
    apikey: STEPZEN_APIKEY,
    account: STEPZEN_ACCOUNT,
    model: STEPZEN_MODEL,
    configFile: STEPZEN_CONFIGFILE, // Optional, no default
    folder: STEPZEN_FOLDER ? STEPZEN_FOLDER : "api",
    host: STEPZEN_HOST ? STEPZEN_HOST : "stepzen",
    schemaDir: STEPZEN_SCHEMADIR ? STEPZEN_SCHEMADIR : "stepzen",
  };

  // deploy the stepzen bundle
  stepzenDeployedEndpoint = await deployStepZenEndpoint(stepzen_bundle);

  const apigee_bundle = {
    stepzen_api_key: STEPZEN_APIKEY,
    stepzen_admin_key: STEPZEN_ADMINKEY,
    template: APIGEE_TEMPLATE_ZIP,
    org: APIGEE_ORG,
    proxyname: APIGEE_PROXYNAME,
    basepath: APIGEE_BASEPATH,
    token: APIGEE_TOKEN,
    target: stepzenDeployedEndpoint.endpointURI,
  };

  // deploy Apigee Proxy

  apigeeDeployedEndpoint = deployApigeeEndpoint(apigee_bundle);

  console.log(
    `
Deployed an Apigee proxy with org = ${apigee_bundle.org}, backed by a StepZen endpoint
at ${stepzenDeployedEndpoint.endpointURI}. These should both be functional now!
`
  );
}

function deployApigeeEndpoint(bundle) {
  // Make a temp folder and load it.
  fs.mkdtemp("temp-", (err, folder) => {
    if (err) throw err;
    console.log(`Using temp folder: ${folder}`);
    // unzip template zip to temp folder
    const unzipcmd = `unzip ${bundle.template} -d ${folder}`;
    exec(unzipcmd, (error, stdout, stderr) => {
      if (error) throw error;
      if (stderr) {
        console.log(`stderr: ${stderr}`);
        return;
      }
      // console.log(`stdout: ${stdout}`);
      // replace values in unzipped files
      const options = {
        files: `${folder}/apiproxy/**/*.xml`,
        from: [
          "$STEPZEN_APIKEY",
          "$STEPZEN_ADMINKEY",
          "$APIGEE_TARGET",
          "$APIGEE_BASEPATH",
          "$APIGEE_PROXYNAME",
        ],
        to: [
          bundle.stepzen_api_key,
          bundle.stepzen_admin_key,
          bundle.target,
          bundle.basepath,
          bundle.proxyname,
        ],
      };
      replace(options, (error, _) => {
        if (error) throw error;
        // download schema to zip Directory
        let headers = {
          Authorization: `apikey ${bundle.stepzen_api_key}`,
          "Content-Type": "application/json",
        };
        downloadSchema(bundle.target, headers)
          .then(function (data) {
            //console.log("downloadSchema:", data);
            let where = `${folder}/apiproxy/resources/graphql`;
            saveToFile(where, data)
              .then(function () {
                console.log("schema saved.");
                //  rezip files
                const zipcmd = `zip -r apiproxy.zip apiproxy`;
                exec(zipcmd, { cwd: `${folder}` }, (error, stdout, stderr) => {
                  if (error) throw error;
                  if (stderr) {
                    console.log(`stderr: ${stderr}`);
                  }
                  // console.log(`stdout: ${stdout}`);
                  // upload new zip to apigee
                  createUpdateProxy(`${folder}/apiproxy.zip`, bundle.token);
                });
              })
              .catch(function (error) {
                console.log("saveToFile:", error);
              });
          })
          .catch(function (error) {
            console.log("downloadSchema:", error);
          });
      });
    });
  });
}

async function deployStepZenEndpoint(bundle) {
  const endpoint = `${bundle.folder}/${bundle.model}`;
  const endpointURI = `https://${bundle.account}.${bundle.host}.net/${endpoint}/__graphql`;

  const client = await stepzen.client({
    account: bundle.account,
    adminkey: bundle.adminkey,
  });
  var configurationSets = ["stepzen/default"];
  if (bundle.configFile) {
    await client.upload.configurationset(endpoint, bundle.configFile);
    configurationSets = [endpoint, "stepzen/default"];
  }
  await client.upload.schema(endpoint, bundle.schemaDir);
  await client.deploy(endpoint, {
    configurationsets: configurationSets,
    schema: endpoint,
  });

  // Log the successful deployment.
  console.log(`Your StepZen endpoint is available at ${endpointURI}`);

  return {
    endpointURI: endpointURI,
  };
}

function createUpdateProxy(proxyzip, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `https://apigee.googleapis.com/v1/organizations/${APIGEE_ORG}/apis?name=${APIGEE_PROXYNAME}&action=import`;
  const form = new FormData();
  form.append("file", fs.createReadStream(proxyzip));
  const headers = form.getHeaders();
  headers.Authorization = authHeader;
  axios
    .post(URL, form, { headers: headers })
    .then(function (response) {
      console.log(response.status, response.statusText);
      //console.log(response.data);
    })
    .catch(function (error) {
      console.log(error.message);
      console.log(error.toJSON());
    });
}

function downloadSchema(endpoint, headers) {
  return new Promise((resolve, reject) => {
    let body = JSON.stringify({ query: getIntrospectionQuery() });
    axios
      .post(endpoint, body, { headers: headers })
      .then(function (response) {
        //console.log(response.status, response.statusText);
        const schema = buildClientSchema(response.data.data);
        const out = printSchema(schema);
        // strip out docstrings.. apigee does not like them
        const regx = /""".*?"""/gs;
        resolve(out.replace(regx, ""));
      })
      .catch(function (error) {
        //console.log(error);
        reject(error);
      });
  });
}

function saveToFile(location, schema) {
  return new Promise((resolve, reject) => {
    try {
      let out = path.resolve(location);
      if (!fs.existsSync(out)) {
        reject("destination dir for schema.graphql does not exist.");
      }
      fs.writeFileSync(`${location}/schema.graphql`, schema);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}
