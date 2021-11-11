const dotenv = require("dotenv");
const replace = require("replace-in-file");
const { exec } = require("child_process");
const util = require('util');
const fs = require("fs");
const axios = require("axios").default;
const FormData = require("form-data");
const app = require("./apigee-tpls/app.json");
const developer = require("./apigee-tpls/developer.json");
const productTpl = require("./apigee-tpls/apiproduct.json");
const { request, gql } = require('graphql-request');

const ACCOUNT_ENDPOINT='https://stepzen.stepzen.net/google/accountlinker/__graphql';

const {
  getIntrospectionQuery,
  buildClientSchema,
  printSchema,
} = require("graphql/utilities");
const path = require("path");
const stepzen = require("@stepzen/sdk");
const { program } = require('commander');
program.version('1.0');

program
  .option('-o, --org <org>', 'Apigee organization')
  .option('-e, --env <env>', 'Apigee environment')
  .option('-t, --token <token>', 'auth token')
  .option('-b, --basepath <basepath>', 'proxy base path', "/graphql/stepzample")
  .option('-n, --proxy-name <proxyName>', 'name of apigee proxy', "StepzenProxy")
  .option('-s, --stepzenhost <stepzenhost>', 'stepzen host', "stepzen")
  .option('-S, --schema-dir <schemaDir>', 'path to stepzen schema directory', "stepzen")
  .option('-m, --model <model>', 'stepzen model', "stepzample")
  .option('-i, --identity-token <identityToken>', 'gcloud identity token')
  .option('-r, --region <region>', 'What region to create components in', 'us-central')
  .option('-d, --debug', 'turn on more debug info');

program.parse(process.argv);

const opts = program.opts();

dotenv.config();

const MGMT_URL = 'https://apigee.googleapis.com/v1/organizations';
const APIGEE_TEMPLATE_ZIP = "apiproxy.zip";
const APIGEE_PROXYNAME=opts.proxyName;
const APIGEE_BASEPATH=opts.basepath;
const STEPZEN_FOLDER="api";
const STEPZEN_HOST=opts.stepzenhost;
const STEPZEN_MODEL=opts.model;

try {
    run();
} catch (e) {
  console.log(e);
}

// Main run function
async function run() {
    if (opts.debug) console.log("Starting run...");
    await validateAndUpdateOpts();
    // Let's start by dealing with the propertyset
    let exists = await getSZPropertySet(opts.apikey, opts.token);
    if ( exists ) {
      console.log('Property set already there... Deleting before recreating')
      await delSZPropertySet(opts.STEPZEN_APIKEY, opts.token);
      await createSZPropertySet(opts.STEPZEN_APIKEY, opts.STEPZEN_ADMINKEY, opts.token);
    }
    else {
      createSZPropertySet(opts.STEPZEN_APIKEY, opts.STEPZEN_ADMINKEY, opts.token);
    }


  // Establish the StepZen variables needed.
  const stepzen_bundle = {
    adminkey: opts.STEPZEN_ADMINKEY,
    apikey: opts.STEPZEN_APIKEY,
    account: opts.STEPZEN_ACCOUNT,
    model: STEPZEN_MODEL,
    folder: STEPZEN_FOLDER ? STEPZEN_FOLDER : "api",
    host: STEPZEN_HOST ? STEPZEN_HOST : "stepzen",
    schemaDir: opts.schemaDir
  };

  // deploy the stepzen bundle
  if (opts.debug) console.log("About to deploy StepZen endpoint with bundle: %j", stepzen_bundle);
  stepzenDeployedEndpoint = await deployStepZenEndpoint(stepzen_bundle);

  const apigee_bundle = {
    stepzen_api_key: opts.STEPZEN_APIKEY,
    stepzen_admin_key: opts.STEPZEN_ADMINKEY,
    template: APIGEE_TEMPLATE_ZIP,
    org: opts.org,
    proxyname: APIGEE_PROXYNAME,
    basepath: APIGEE_BASEPATH,
    token: opts.token,
    target: stepzenDeployedEndpoint.endpointURI,
  };

  // deploy Apigee Proxy
  if (opts.debug) console.log("About to deploy Apigee Proxy with bundle: %j", apigee_bundle);
  apigeeDeployedEndpoint = deployApigeeEndpoint(apigee_bundle);
 
  await delDevStuff(opts.apikey, opts.token);
  await createDevStuff(opts.apikey, opts.token);

  console.log(
    `
Deployed an Apigee proxy with org = ${apigee_bundle.org}, backed by a StepZen endpoint
at ${stepzenDeployedEndpoint.endpointURI}. These should both be functional now!

Your Apigee API Key is : ${opts.apigeeAPIKey}. Pass this in as a queryparameter to your new proxy as apikey=${opts.apigeeAPIKey}
`
  );
}

// fetch account info from StepZen account endpoint
async function getAccountDetails() {
  let query = `
    {
  getAccountDetails(jwtToken: "${opts.identityToken}") {
    accountName
    adminKey
    apiKey
  }
}
`;

  if (opts.debug) console.log("About to call StepZen account endpoint with query: %s", query);
  return request(ACCOUNT_ENDPOINT, query);
}


// validate 
async function validateAndUpdateOpts() {
    getAccountDetails()
    .then( d => {
        if (opts.debug) console.log("Setting ADMINKEY: %s, APIKEY:%s, and ACCOUNT:%s", d.getAccountDetails.adminKey, d.getAccountDetails.apiKey, d.getAccountDetails.accountName);

        opts.STEPZEN_ADMINKEY = d.getAccountDetails.adminKey;
        opts.STEPZEN_APIKEY = d.getAccountDetails.apiKey;
        opts.STEPZEN_ACCOUNT = d.getAccountDetails.accountName;
    })
    .catch( e => {
        console.error( `Failed while calling StepZen account endpoint with: ${e.message}`);
        console.error( "Are you sure you provided a proper id token?");
        process.exit(1);
    });
}


function deployApigeeEndpoint(bundle) {
  // Make a temp folder and load it.
  fs.mkdtemp("temp-", (err, folder) => {
    if (err) throw err;
    console.log(`Using temp folder: ${folder}`);
    // unzip template zip to temp folder
    if (opts.debug) console.log("Unzipping %s into Folder: %s", bundle.template, folder);
    const unzipcmd = `unzip ${bundle.template} -d ${folder}`;
    exec(unzipcmd, (error, stdout, stderr) => {
      if (error) throw error;
      if (stderr) {
        console.error(`Unzip error! stderr: ${stderr}`);
        return;
      }
      // console.log(`stdout: ${stdout}`);
      // replace values in unzipped files
      const options = {
        files: `${folder}/apiproxy/**/*.xml`,
        from: [
          "$APIGEE_TARGET",
          "$APIGEE_BASEPATH",
          "$APIGEE_PROXYNAME",
        ],
        to: [
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
            if (opts.debug) console.log("Updating exploded proxy with graphql scheme file here: %s", where);
            saveToFile(where, data)
              .then(function () {
                console.log("schema saved.");
                //  rezip files
                const zipcmd = `zip -r apiproxy.zip apiproxy`;
                exec(zipcmd, { cwd: `${folder}` }, async (error, stdout, stderr) => {
                  if (error) throw error;
                  if (stderr) {
                    console.log(`stderr: ${stderr}`);
                  }
                  // console.log(`stdout: ${stdout}`);
                  // upload new zip to apigee
                  await createUpdateProxy(`${folder}/apiproxy.zip`, bundle.token);

                  if (opts.debug) console.log("About to delete temp directory: %s", folder);
                  fs.rmdirSync(folder, { recursive: true });
                });
              })
              .catch(function (error) {
                console.error("Failed while saving scheme. SaveToFile:", error);
              });
          })
          .catch(function (error) {
            console.error("Failed while downloading schema from graphql endpoint. downloadSchema:", error);
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
    if (opts.debug) console.log("Going to upload configurationset to StepZen using endpoint: %s", endpoint);
    await client.upload.configurationset(endpoint, bundle.configFile);
    configurationSets = [endpoint, "stepzen/default"];
  }
  if (opts.debug) console.log("Uploading schema from: %s", bundle.schemaDir);
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
 
// Check for extant StepZen propertyset
function getSZPropertySet(apikey, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `${MGMT_URL}/${opts.org}/environments/${opts.env}/resourcefiles/properties/StepZen`;
  let headers = {};
  headers.Authorization = authHeader;
  return axios
    .get(URL, { validateStatus: false, headers: headers })
    .then( r => {
      if ( r.status === 200 ) {
          return true;
      }
      else if ( r.status === 404 ) {
          return false;
      }
      else {
        console.log("Failed fetching the property set: %s", r.data);
        return false;
      }
    })
    .catch(function (error) {
      console.error("Failed while trying to fetch StepZen property set: %s", error.message);
    });
}

// Delete StepZen propertyset
function delSZPropertySet(apikey, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `${MGMT_URL}/${opts.org}/environments/${opts.env}/resourcefiles/properties/StepZen`;
  let headers = {};
  headers.Authorization = authHeader;
  return axios
    .delete(URL, { params: {}, headers: headers })
    .then( r => {
      console.log("Deleted property set");
    })
    .catch( e => {
      console.error("Error deleting property set: %j", e.message);
    });
}

// Create StepZen property set
function createSZPropertySet(apikey, adminkey, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `${MGMT_URL}/${opts.org}/environments/${opts.env}/resourcefiles?name=StepZen&type=properties`;
  const form = new FormData();
  form.append("file", `#StepZen Properties
apikey=${apikey}
adminkey=${adminkey}`);
  const headers = form.getHeaders();
  headers.Authorization = authHeader;
  return axios
    .post(URL, form, { headers: headers })
    .then( r => {
      console.log("Created property set");
    })
    .catch(function (error) {
      console.error("Failed while trying to create StepZen property set: %s", error.message);
    });
}

// Delete Apigee app, dev, and product
async function delDevStuff(apikey, token) {
  const authHeader = `Bearer ${token}`;
  let AppURL = `${MGMT_URL}/${opts.org}/developers/apizen@apizen.com/apps/APIZenApp`;
  let DevURL = `${MGMT_URL}/${opts.org}/developers/apizen@apizen.com`;
  let ProdURL = `${MGMT_URL}/${opts.org}/apiproducts/APIZenProduct`;

  let headers = {};
  headers.Authorization = authHeader;

  await axios
    .delete(AppURL, { validateStatus: false, params: {}, headers: headers })
    .then( r => {
      console.log("Deleted App");
    })
    .catch( e => {
      console.error("Error deleting app: %j", e.message);
    });

  await axios
    .delete(DevURL, { validateStatus: false, params: {}, headers: headers })
    .then( r => {
      console.log("Deleted Developer");
    })
    .catch( e => {
      console.error("Error deleting developer: %j", e.message);
    });

  await axios
    .delete(ProdURL, { validateStatus: false, params: {}, headers: headers })
    .then( r => {
      console.log("Deleted API Product");
    })
    .catch( e => {
      console.error("Error deleting apiproduct: %j", e.message);
    });
}
 
// Create Apigee app, dev, and product
async function createDevStuff(apikey, token) {
  const authHeader = `Bearer ${token}`;
  let AppURL = `${MGMT_URL}/${opts.org}/developers/apizen@apizen.com/apps`;
  let DevURL = `${MGMT_URL}/${opts.org}/developers`;
  let ProdURL = `${MGMT_URL}/${opts.org}/apiproducts`;

  let apiproduct = productTpl;

  apiproduct.environments[0] = opts.env;
  apiproduct.operationGroup.operationConfigs[0].apiSource = opts.proxyName;

  let headers = {};
  headers.Authorization = authHeader;
  headers["Content-Type"] = "application/json";

  await axios
    .post(DevURL, developer, { params: {}, headers: headers })
    .then( r => {
      console.log("Created Developer");
    })
    .catch( e => {
      console.error("Error creating developer: %s", e.message);
    });

  await axios
    .post(ProdURL, apiproduct, { headers: headers })
    .then( r => {
      console.log("Created API Product");
    })
    .catch( e => {
      console.error("Error creating apiproduct: %s", e.message);
    });

  await axios
    .post(AppURL, app, { headers: headers })
    .then( async r => {
      console.log("Created App");
      let key = r.data.credentials[0].consumerKey;
      await axios.post( `${AppURL}/APIZenApp/keys/${key}`, { "apiProducts" : [ "APIZenProduct" ] }, { headers: headers } )
        .then( r => {
            console.log( "Created key and product association" );
        })
        .catch( e => {
          console.error("Error creating product association in app: %s", e.message);
        });

        // add our key back to opts so we can spit it out later
        opts.apigeeAPIKey = key;
    })
    .catch( e => {
      console.error("Error creating app: %s", e.message);
    });

}

// create and/or update the apigee proxy
function createUpdateProxy(proxyzip, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `https://apigee.googleapis.com/v1/organizations/${opts.org}/apis?name=${APIGEE_PROXYNAME}&action=import`;
  const form = new FormData();
  form.append("file", fs.createReadStream(proxyzip));
  const headers = form.getHeaders();
  headers.Authorization = authHeader;
  axios
    .post(URL, form, { headers: headers })
    .then(async function (response) {
      let rev = response.data.revision;
      let deployURL = `https://apigee.googleapis.com/v1/organizations/${opts.org}/environments/${opts.env}/apis/${opts.proxyName}/revisions/${rev}/deployments?override=true`;
      console.log(response.status, response.statusText);
      //console.log(response.data);
      await axios
        .post(deployURL,'', { headers: headers } )
        .then( d => {
            console.log( "Successfully deployed your proxy. Deployment status: %s", d.statusText);
        })
        .catch(function (error) {
          console.error("Failed deploying proxy: %s", error.message);
          console.error(error);
        });
    })
    .catch(function (error) {
      console.error("Failed while trying to upload Apigee proxy: %s", error.message);
    });
}

// fetch the schema from the stepzen endpoint
function downloadSchema(endpoint, headers) {
  if (opts.debug) console.log("Downloading schema");
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
        console.error("Failed deploying proxy: %s", error.message);
      });
  });
}

// write schema to a file
function saveToFile(location, schema) {
  if (opts.debug) console.log(`Saving schema to: ${location}/schema.graphql`);
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
