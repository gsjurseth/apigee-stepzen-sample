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

const ACCOUNT_ENDPOINT='https://berkeley.stepzen.net/api/winning-numbat/__graphql';

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
  .option('-a, --apikey <apikey>', 'AZ apikey')
  .option('-t, --token <token>', 'auth token')
  .option('-b, --basepath <basepath>', 'proxy base path', "/graphql/breweries")
  .option('-s, --stepzenhost <stepzenhost>', 'stepzen host', "stepzen")
  .option('-m, --model <model>', 'stepzen model', "breweries")
  .option('-m, --model <model>', 'stepzen model', "breweries")
  .option('-i, --identity-token <id>', 'gcloud identity token')
  .option('-r, --region <region>', 'What region to create components in', 'us-central');

program.parse(process.argv);

const opts = program.opts();

dotenv.config();

const MGMT_URL = 'https://apigee.googleapis.com/v1/organizations';
const APIGEE_TEMPLATE_ZIP = "apiproxy.zip";
const APIGEE_PROXYNAME=opts.basepath;
const APIGEE_BASEPATH="/graphql/breweries";
const STEPZEN_FOLDER="api";
const STEPZEN_HOST=opts.stepzenhost;
const STEPZEN_MODEL=opts.model;
const STEPZEN_CONFIGFILE=opts.config;

const {
  STEPZEN_ADMINKEY,
  STEPZEN_APIKEY,
  STEPZEN_ACCOUNT,
  STEPZEN_SCHEMADIR, // defaults to stepzen
} = process.env;

try {
    run();
} catch (e) {
  console.log(e);
}

// Main run function
async function run() {
    await validateAndUpdateOpts();
    // Let's start by dealing with the propertyset
    let exists = await getSZPropertySet(opts.apikey, opts.token);
    if ( exists ) {
      console.log('Property set already there... Deleting before recreating')
      await delSZPropertySet(opts.apikey, opts.token);
      await createSZPropertySet(opts.apikey, opts.token);
    }
    else {
      createSZPropertySet(opts.apikey, opts.token);
    }


  // Establish the StepZen variables needed.
  const stepzen_bundle = {
    adminkey: opts.STEPZEN_ADMINKEY,
    apikey: opts.STEPZEN_APIKEY,
    account: opts.STEPZEN_ACCOUNT,
    model: STEPZEN_MODEL,
    configFile: STEPZEN_CONFIGFILE, // Optional, no default
    folder: STEPZEN_FOLDER ? STEPZEN_FOLDER : "api",
    host: STEPZEN_HOST ? STEPZEN_HOST : "stepzen",
    schemaDir: STEPZEN_SCHEMADIR ? STEPZEN_SCHEMADIR : "stepzen",
  };

  // deploy the stepzen bundle
  stepzenDeployedEndpoint = await deployStepZenEndpoint(stepzen_bundle);

  const apigee_bundle = {
    stepzen_api_key: opts.STEPZEN_APIKEY,
    stepzen_admin_key: opts.STEPZEN_ADMINKEY,
    template: APIGEE_TEMPLATE_ZIP,
    org: opts.APIGEE_ORG,
    proxyname: APIGEE_PROXYNAME,
    basepath: APIGEE_BASEPATH,
    token: opts.APIGEE_TOKEN,
    target: stepzenDeployedEndpoint.endpointURI,
  };

  // deploy Apigee Proxy

 // apigeeDeployedEndpoint = deployApigeeEndpoint(apigee_bundle);
 
    await delDevStuff(opts.apikey, opts.token);
    await createDevStuff(opts.apikey, opts.token);

  console.log(
    `
Deployed an Apigee proxy with org = ${apigee_bundle.org}, backed by a StepZen endpoint
at ${stepzenDeployedEndpoint.endpointURI}. These should both be functional now!
`
  );
}

// fetch account info from StepZen account endpoint
async function getAccountDetails() {
  let query = `
    {
  getAccountDetails(jwtToken: "${opts.id}") {
    accountName
    adminKey
    apiKey
  }
}
`;
  return request(ACCOUNT_ENDPOINT, query);
}


// validate 
async function validateAndUpdateOpts() {
    getAccountDetails()
    .then( d => {
        opts.STEPZEN_ADMINKEY = d.getAccountDetails.adminKey;
        opts.STEPZEN_APIKEY = d.getAccountDetails.apiKey;
        opts.STEPZEN_ACCOUNT = d.getAccountDetails.accountName;
        console.log("Our opts: %j", opts);
    });
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

//curl -X POST "https://apigee.googleapis.com/v1/organizations/geirs-purdy-project/environments/test1/resourcefiles?name=StepZen&type=properties" -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-type: multipart/form-data" -F file="apikey=lakezurich::stepzen.net+1000::0577c900dafd401b35106c0b61ba7eab27572424173b0861776978a3fc271116"
 
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
      console.log(error.message);
      console.log(error.toJSON());
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
      console.log("Error deleting property set: %j", e.response);
    });
}

// Create StepZen property set
function createSZPropertySet(apikey, token) {
  const authHeader = `Bearer ${token}`;
  const URL = `${MGMT_URL}/${opts.org}/environments/${opts.env}/resourcefiles?name=StepZen&type=properties`;
  const form = new FormData();
  form.append("file", `apikey=${apikey}`);
  const headers = form.getHeaders();
  headers.Authorization = authHeader;
  return axios
    .post(URL, form, { headers: headers })
    .then( r => {
      console.log("Created property set");
    })
    .catch(function (error) {
      console.log(error.message);
      console.log(error.toJSON());
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
      console.log("Error deleting app: %j", e.response);
    });

  await axios
    .delete(DevURL, { validateStatus: false, params: {}, headers: headers })
    .then( r => {
      console.log("Deleted Developer");
    })
    .catch( e => {
      console.log("Error deleting developer: %j", e.response);
    });

  await axios
    .delete(ProdURL, { validateStatus: false, params: {}, headers: headers })
    .then( r => {
      console.log("Deleted API Product");
    })
    .catch( e => {
      console.log("Error deleting apiproduct: %j", e.response);
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

  let headers = {};
  headers.Authorization = authHeader;
  headers["Content-Type"] = "application/json";

  await axios
    .post(DevURL, developer, { params: {}, headers: headers })
    .then( r => {
      console.log("Created Developer");
    })
    .catch( e => {
      console.log("Error creating developer: %s", e.message);
    });

  await axios
    .post(ProdURL, apiproduct, { headers: headers })
    .then( r => {
      console.log("Created API Product");
    })
    .catch( e => {
      console.log("Error creating apiproduct: %s", e.message);
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
          console.log("Error creating product association in app: %s", e.message);
        });
    })
    .catch( e => {
      console.log("Error creating app: %s", e.message);
    });

}

// create and/or update the apigee proxy
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

// fetch the schema from the stepzen endpoint
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

// write schema to a file
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
