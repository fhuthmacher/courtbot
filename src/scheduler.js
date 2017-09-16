const cheerio = require('cheerio')
const moment = require('moment-timezone')
const request = require('request')

const tz = 'America/New_York'

class Scheduler {
  constructor () {
    const mitRecreationUsernames = process.env.MIT_RECREATION_USERNAMES.split(',')
    const mitRecreationPasswords = process.env.MIT_RECREATION_PASSWORDS.split(',')

    // Zip usernames and passwords together.
    this.credentials = mitRecreationUsernames.map((el, i) => [el, mitRecreationPasswords[i]])

    this.baseUrl = 'https://east-a-60ols.csi-cloudapp.net'
    this.jar = request.jar()
  }

  login (username, password) {
    // Login to the MIT Recreation website.
    let form = require('./forms/login.json')
    form.ctl00$pageContentHolder$loginControl$UserName = username
    form.ctl00$pageContentHolder$loginControl$Password = password

    // For some unknown reason, this cookie won't be set if it's not present before
    // the login request is made. The value of the cookie is overwritten during
    // login. It's also worth noting that ASP.NET does not explicitly couple a
    // specific forms authentication cookie to an ASP.NET_SessionId. Any valid
    // forms authentication cookie can be used with any other valid session cookie,
    // unless the user's identity is manually added to the session and compared
    // with the identity tied to the forms auth cookie, which the MIT Recreation
    // website doesn't do.
    // http://blog.securityps.com/2013/06/session-fixation-forms-authentication.html?m=1
    const cookie = request.cookie('.CSIASPXFORMSAUTH=dummy')
    this.jar.setCookie(cookie, this.baseUrl)

    const options = {
      url: this.baseUrl + '/MIT/Login.aspx?AspxAutoDetectCookieSupport=1',
      jar: this.jar,
      form,
      followAllRedirects: true,
    }

    return new Promise((resolve, reject) => {
      request.post(options, (error, response, body) => {
        error ? reject(error) : resolve(response)
      })
    })
  }

  look (isTomorrow) {
    // Retrieve court availability data. Data comes from the same API used by the
    // MIT Recreation scheduling application. Accessing it doesn't require authentication.
    // Courts can only be booked by the hour, but the API returns minute-by-minute
    // court availability. ಠ_ಠ
    const options = {
      url: this.baseUrl + '/MIT/Library/OlsService.asmx/GetSchedulerResourceAvailability',
      json: true,
      body: {
        siteId: '1261',
        // Each court has a resource ID. Z-Center courts 1-5 have resource IDs 17-21.
        resourceIds: Array.from(Array(5), (_, k) => `${k + 17}`),
        selectedDate: moment().tz(tz).add(isTomorrow ? 1 : 0, 'd').format('L'),
      },
    }

    return new Promise((resolve, reject) => {
      request.post(options, (error, response, body) => {
        error ? reject(error) : resolve(body)
      })
    })
  }

  stage (courtNumber, hour, isTomorrow) {
    // Stage a court reservation. It must be confirmed separately. Hour should be
    // an hour on a 24-hour clock.
    const scheduleData = {
      ScheduleDate: moment().tz(tz).add(isTomorrow ? 1 : 0, 'd').format('L'),
      Duration: 60,
      Resource: `Zesiger Squash Court #${courtNumber}`,
      Provider: '',
      SiteId: 1261,
      ProviderId: 0,
      // This resource ID must be a string. Don't ask me why.
      ResourceId: (courtNumber + 16).toString(),
      ServiceId: 4,
      ServiceName: 'Recreational Squash',
      ServiceUniqueIdentifier: '757170ab-4338-4ff6-868d-2fb51cc449f8',
    }

    const options = {
      url: this.baseUrl + '/MIT/Library/OlsService.asmx/SetScheduleInformation',
      jar: this.jar,
      json: true,
      body: {
        // The values for both of these keys need to be strings. (╯ಠ_ಠ）╯︵ ┻━┻
        scheduleInformation: JSON.stringify(scheduleData),
        startTime: (hour * 60).toString(),
      },
    }

    // This request "stages" a reservation, but doesn't complete it.
    return new Promise((resolve, reject) => {
      request.post(options, (error, response, body) => {
        error ? reject(error) : resolve(response)
      })
    })
  }

  confirm () {
    // Confirm a staged court reservation.
    const url = this.baseUrl + '/MIT/Members/Scheduler/AddFamilyMembersScheduler.aspx?showOfflineMessage=true'

    return new Promise((resolve, reject) => {
      request.get({url, jar: this.jar}, (error, response, body) => {
        if (error) {
          reject(error)
        } else {
          const $ = cheerio.load(body)

          let form = require('./forms/confirm.json')
          form.__VIEWSTATE = $('#__VIEWSTATE').val()
          form.ctl00$rnHf = $('#ctl00_rnHf').val()

          const headers = {
            // Without this header, the subsequent POST will fail. Looks like the
            // booking backend might block requests without a User-Agent header.
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
          }

          const options = {
            url,
            headers,
            jar: this.jar,
            form,
            followAllRedirects: true,
          }

          request.post(options, (error, response, body) => {
            if (error) {
              reject(error)
            } else {
              const encodedPath = body.split('|').slice(-2)[0]
              const decodedPath = decodeURIComponent(encodedPath)

              const options = {
                url: this.baseUrl + decodedPath,
                jar: this.jar,
                followAllRedirects: true,
              }

              request.get(options, (error, response, body) => {
                if (error) {
                  reject(error)
                } else {
                  const $ = cheerio.load(body)
                  const thankYou = $('#ctl00_pageContentHolder_lblThankYou').text()

                  if (thankYou) {
                    resolve(response)
                  } else {
                    reject(response)
                  }
                }
              })
            }
          })
        }
      })
    })
  }

  book (courtNumber, hour, isTomorrow) {
    return new Promise((resolve, reject) => {
      let errors = []

      // I call this function recursively to execute the promises returned by the
      // booking functions serially. You can't just use a for loop and break out
      // of it because the booking functions are asynchronous. If you try to loop
      // across all credential pairs, you'll end up queueing booking attempts with
      // every username and password (instead of stopping early when one works).
      const attemptBooking = index => {
        if (index < this.credentials.length) {
          let [username, password] = this.credentials[index]

          this.login(username, password)
            .then(_ => {
              console.log(`Logged in as ${username}`)
              // Remember to always return promises up! Otherwise callbacks won't
              // chain, and errors won't be caught. Arrow functions only return
              // implicitly when brackets are left out. For more, see
              // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises#Chaining
              return this.stage(courtNumber, hour, isTomorrow)
            })
            .then(_ => {
              console.log('Staged reservation')
              return this.confirm()
            })
            .then(_ => {
              console.log('Confirmed reservation!')
              resolve('Success')
            })
            .catch(error => {
              console.log(`Attempt to book as ${username} failed`)
              errors.push(error)
              attemptBooking(index + 1)
            })
        } else {
          reject(errors)
        }
      }

      attemptBooking(0)
    })
  }
}

module.exports = Scheduler
