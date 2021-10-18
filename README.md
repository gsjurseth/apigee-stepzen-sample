# Google Apigee-StepZen Demo

1. Cloud SQL
1. Maps API
1. _StepZen_
1. _Apigee_

## Steps

1. Create Cloud SQL instance

`gcloud sql instances create demopg --database-version=POSTGRES_13 --memory=4096MB --cpu=2 --region=us-central`

2. Create database

`gcloud sql databases create breweries --instance=demopg`

3. Set password for default user

`gcloud sql users set-password postgres --instance=demopg --prompt-for-password`

4. Start Cloud SQL Proxy.

`cloud_sql_proxy -instances=$(gcloud sql instances describe demopg | grep connectionName | cut -d\ -f2)=tcp:5432`

5. Connect to db using psql client

`psql "host=127.0.0.1 sslmode=disable dbname=breweries user=postgres"`

6. run the `breweries.sql` file

`breweries=> \i breweries.sql`

7. `exit` plsql and kill the cloud_sql_proxy session. Database is loaded.

8. Set network access for StepZen to connect to db

`gcloud sql instances patch demopg --authorized-networks=34.68.67.42/32`

9. Copy `stepzen/config.yaml.sample` to `stepzen/config.yaml`

10. Set postgres user/pass/ip in `stepzen/config.yaml`

11. Set Google Maps apikey in `stepzen/config.yaml`

12. Set {apigee-org} in `apizen-template`

13. If you have not already installed the stepzen cli do steps 14 and 15, otherwise skip to step 17.

14. `npm install -g stepzen`

15. `stepzen login` (follow prompts, getting account info from https://stepzen.com/account)

16. `stepzen list schemas` just to confirm things work

17. `npm install`

18. `./apizen-template` to deploy the StepZen GraphQL API, and deploy the Apigee bundle.

19. Log in to Apigee, create products and apps, and deploy the Apigee proxy.
