import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 90000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  try {
    const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
    locationsLoop:
    for (const [i, location] of locations.entries()) {
      const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
      console.log(`${dayjs().format()} - Search at ${logLocation}`)
      await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

      // select tennis location
      await page.locator('.tokens-input-text').pressSequentially(`${location} `)
      await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
      await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

      // select date
      await page.click('#when')
      const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
      await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
      await page.waitForSelector('.date-picker', { state: 'hidden' })

      await page.click('#rechercher')

      // wait until the results page is fully loaded before continue
      await page.waitForLoadState('domcontentloaded')

      // Diagnostic: afficher tous les créneaux retournés par le site
const allSlots = await page.locator('[datedeb]').evaluateAll(elements =>
  elements.map(el => ({
    datedeb: el.getAttribute('datedeb'),
    courtid: el.getAttribute('courtid')
  }))
)

console.log(
  `${dayjs().format()} - All returned slots (${allSlots.length}):`
)

for (const slot of allSlots) {
  console.log(
    `${dayjs().format()} - datedeb="${slot.datedeb}", courtid="${slot.courtid}"`
  )
}

      let selectedHour
      let totalSlotsFound = 0
      let totalSlotsRejected = 0
      
      console.log(
  `${dayjs().format()} - Search parameters: ` +
  `location="${location}", ` +
  `date="${date.format('DD/MM/YYYY')}", ` +
  `hours=[${config.hours.join(', ')}], ` +
  `priceType=[${config.priceType.join(', ')}], ` +
  `courtType=[${config.courtType.join(', ')}]`
)
      hoursLoop:
      for (const hour of config.hours) {
  const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
  const slotCount = await page.locator(dateDeb).count()

  console.log(
    `${dayjs().format()} - Hour ${hour}:00: ${slotCount} matching slot(s)`
  )

  totalSlotsFound += slotCount

  if (slotCount) {
    if (await page.isHidden(dateDeb)) {
      await page.click(
        `#head${location.replaceAll(' ', '')}${hour}h .panel-title`
      )
    }

    const courtNumbers =
      !Array.isArray(config.locations)
        ? config.locations[location]
        : []

    const slots = await page.locator(dateDeb).all()

    for (const slot of slots) {
      const courtId = await slot.getAttribute('courtid')
      const bookSlotButton =
        `[courtid="${courtId}"]${dateDeb}`

      let courtName = 'unknown'

      if (courtNumbers.length > 0) {
        courtName = (
          await page
            .locator(`.court:left-of(${bookSlotButton})`)
            .innerText()
        ).trim()

        const courtMatch = courtName.match(/Court N°(\d+)/)
        const courtNumber = courtMatch
          ? parseInt(courtMatch[1])
          : NaN

        if (!courtNumbers.includes(courtNumber)) {
          console.log(
            `${dayjs().format()} - Rejecting courtid=${courtId}, ` +
            `court="${courtName}" because court number is not configured`
          )
          totalSlotsRejected++
          continue
        }
      }

      const priceDescription =
        await page
          .locator(
            `.row.tennis-court:has(${bookSlotButton})`
          )
          .locator('.price-description')
          .innerHTML()

      const [priceType, courtType] =
        priceDescription
          .split('<br>')
          .map(value => value.trim())

      console.log(
        `${dayjs().format()} - Candidate ` +
        `courtid=${courtId}, ` +
        `court="${courtName}", ` +
        `priceType="${priceType}", ` +
        `courtType="${courtType}"`
      )

      if (
        !config.priceType.includes(priceType) ||
        !config.courtType.includes(courtType)
      ) {
        console.log(
          `${dayjs().format()} - Rejecting courtid=${courtId}: ` +
          `price/court type does not match configuration`
        )
        totalSlotsRejected++
        continue
      }

      console.log(
        `${dayjs().format()} - ACCEPTING courtid=${courtId} ` +
        `for ${hour}:00`
      )

      selectedHour = hour
      await page.click(bookSlotButton)

      break hoursLoop
    }
  }
}

console.log(
  `${dayjs().format()} - Search summary: ` +
  `${totalSlotsFound} slot(s) found, ` +
  `${totalSlotsRejected} rejected, ` +
  `selectedHour=${selectedHour ?? 'none'}, ` +
  `pageTitle="${await page.title()}"`
)

      if (await page.title() !== 'Paris | TENNIS - Reservation') {
        console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
        continue
      }

      await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"')

      for (const [i, player] of config.players.entries()) {
        if (i > 0) {
          await page.click('.addPlayer')
        }
        await page.waitForSelector(`[name="player${i + 1}"]`)
        await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
        await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
      }

      await page.keyboard.press('Enter')

      await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
      const paymentMode = page.locator('#order_select_payment_form #paymentMode')
      await paymentMode.evaluate(el => {
        el.removeAttribute('readonly')
        el.style.display = 'block'
      })
      await paymentMode.fill('existingTicket')

      if (DRY_RUN_MODE) {
        console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
        if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
        console.log('----- DRY RUN END -----')
        console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

        await page.click('#previous')
        await page.click('#btnCancelBooking')

        break locationsLoop
      }

      const submit = page.locator('#order_select_payment_form #envoyer')
      await submit.evaluate(el => el.classList.remove('hide'))
      await submit.click()

      await page.waitForSelector('.confirmReservation')

      // Extract reservation details
      const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
      const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
      const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

      if (!process.env.GITHUB_ACTIONS) {
        console.log(`${dayjs().format()} - Réservation faite : ${address}`)
        console.log(`pour le ${dateStr}`)
        console.log(`sur le ${court}`)
      } else {
        console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
      }

      const [day, month, year] = [date.date(), date.month() + 1, date.year()]
      const hourMatch = dateStr.match(/(\d{2})h/)
      const hour = hourMatch ? Number(hourMatch[1]) : 12
      const start = [year, month, day, hour, 0]
      const duration = { hours: 1, minutes: 0 }
      const event = {
        start,
        duration,
        title: 'Réservation Tennis',
        description: `Court: ${court}\nAdresse: ${address}`,
        location: address,
        status: 'CONFIRMED',
      }

      const createdEvent = createEvent(event)
      if (createdEvent.error) {
        console.log('ICS creation error:', createdEvent.error)

        break
      }

      const { value } = createdEvent
      if (!process.env.GITHUB_ACTIONS) {
        writeFileSync('event.ics', value)
      }
      if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
        await notify(Buffer.from(value, 'utf8'), 'event.ics',
          `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
            domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
            topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
          })
      }

      break
    }
  } catch (e) {
    console.log(e)
    const screenshot = await page.screenshot({ path: 'img/failure.png' })

    if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()
