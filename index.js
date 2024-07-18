const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const csv = require('csv-parser');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const token = process.env.DISCORD_BOT_TOKEN;

let students = [];
let verifiedUsers = [];

// Load verified users
if (fs.existsSync('verifiedUsers.json')) {
  verifiedUsers = JSON.parse(fs.readFileSync('verifiedUsers.json'));
}

// Load student data
fs.createReadStream('student.csv')
  .pipe(csv())
  .on('data', (row) => {
    students.push(row);
  })
  .on('end', () => {
    console.log('CSV file successfully processed');
  });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const channel = client.channels.cache.find(ch => ch.name === 'ktu-announcements');
  if (channel) {
    await channel.send('Bot is now online and ready to fetch KTU announcements!');
    fetchAndPostKTUAnnouncements(channel); // Initial fetch
    setInterval(() => fetchAndPostKTUAnnouncements(channel), 3600 * 1000); // Fetch every 1 hour
  } else {
    console.error('KTU Announcements channel not found.');
  }
});

client.on('guildMemberAdd', async (member) => {
  if (verifiedUsers.includes(member.id)) {
    console.log(`${member.user.tag} is already verified.`);
    const memberRole = member.guild.roles.cache.find(role => role.name === 'Members');
    if (memberRole) {
      await member.roles.add(memberRole).catch(console.error);
    }
  } else {
    const unverifiedRole = member.guild.roles.cache.find(role => role.name === 'Unverified');
    if (unverifiedRole) {
      try {
        await member.roles.add(unverifiedRole);
        console.log(`Assigned Unverified role to ${member.user.tag}`);
      } catch (error) {
        console.error(`Failed to assign Unverified role to ${member.user.tag}:`, error);
      }
    } else {
      console.error('Unverified role not found.');
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase() === '!news') {
    // Manual trigger to fetch and post KTU announcements
    await fetchAndPostKTUAnnouncements(message.channel);
  }

  if (message.channel.name === 'verify' && message.content.toLowerCase() === 'verify') {
    if (verifiedUsers.includes(message.author.id)) {
      await message.reply('You are already verified.');
      return;
    }

    await message.reply('Please type your first name.');

    const filter = (m) => !m.author.bot && m.author.id === message.author.id;
    const collector = message.channel.createMessageCollector({ filter, time: 60000 });

    let step = 0;
    let studentData = {};

    collector.on('collect', async (m) => {
      if (step === 0) {
        studentData.firstname = m.content.trim().toLowerCase();
        console.log('Collected First Name:', studentData.firstname);

        const nameExists = students.some((student) =>
          student.firstname.toLowerCase() === studentData.firstname
        );

        if (nameExists) {
          await m.reply('Type your department (e.g., CSE, ECE, CIVIL, etc.).');
          step++;
        } else {
          await m.reply('First name not found. Please check your details and try again.');
          collector.stop();
        }
      } else if (step === 1) {
        studentData.Branch = m.content.trim().toUpperCase();
        console.log('Collected Branch:', studentData.Branch);

        const deptExists = students.some((student) =>
          student.firstname.toLowerCase() === studentData.firstname &&
          student.Branch.toUpperCase() === studentData.Branch
        );

        if (deptExists) {
          await m.reply('Type your phone number.');
          step++;
        } else {
          await m.reply('Department does not match the first name. Please check your details and try again.');
          collector.stop();
        }
      } else if (step === 2) {
        studentData.phone = m.content.trim();
        console.log('Collected Phone Number:', studentData.phone);

        const isStudentValid = students.find((student) =>
          student.firstname.toLowerCase() === studentData.firstname &&
          student.Branch.toUpperCase() === studentData.Branch &&
          student.phone === studentData.phone
        );

        if (isStudentValid) {
          await m.reply('You have been verified and will be moved to the members group.');
          const unverifiedRole = message.guild.roles.cache.find((role) => role.name === 'Unverified');
          const memberRole = message.guild.roles.cache.find((role) => role.name === 'Members');

          if (unverifiedRole) {
            console.log('Unverified role found, attempting to remove it.');
            await message.member.roles.remove(unverifiedRole).catch(console.error);
          } else {
            console.log('Unverified role not found.');
          }

          if (memberRole) {
            console.log('Member role found, attempting to add it.');
            await message.member.roles.add(memberRole).catch(err => {
              console.error('Error adding member role:', err);
            });
            console.log(`Role ${memberRole.name} added to ${message.member.user.tag}.`);
          } else {
            console.log('Member role not found.');
          }

          // Add user to verifiedUsers and save to file
          verifiedUsers.push(message.author.id);
          fs.writeFileSync('verifiedUsers.json', JSON.stringify(verifiedUsers));

          // Rename the user in the server
          const newNickname = `${studentData.firstname}-${studentData.Branch}-${studentData.phone.slice(-3)}`;
          await message.member.setNickname(newNickname).catch(err => {
            console.error('Error setting nickname:', err);
          });
          console.log(`Renamed ${message.member.user.tag} to ${newNickname}`);
        } else {
          await m.reply('Phone number does not match the details provided. Please check your details and try again.');
        }
        collector.stop();
      }
    });

    collector.on('end', async (collected) => {
      if (collected.size < 3) {
        await message.reply('Verification timed out. Please try again.');
      }
    });
  }
});

async function fetchAndPostKTUAnnouncements(channel) {
  try {
    // Send a loading message
    const loadingMessage = await channel.send('Please wait, loading KTU announcements...');

    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://ktu.edu.in/menu/announcements');

    // Explicitly wait for 15 seconds to ensure the page is fully loaded
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Take a screenshot of the entire page
    const screenshotBuffer = await page.screenshot();

    await browser.close();

    // Crop the screenshot using sharp
    const croppedImageBuffer = await sharp(screenshotBuffer)
      .extract({ width: 800, height: 600, left: 0, top: 0 }) // Adjust the dimensions and position as needed
      .toBuffer();

    // Edit the loading message to include the screenshot and link
    await loadingMessage.edit({
      content: 'Here are the latest KTU announcements: https://ktu.edu.in/menu/announcements',
      files: [{ attachment: croppedImageBuffer, name: 'ktu-announcements.png' }],
    });
  } catch (error) {
    console.error('Error fetching KTU announcements:', error);
  }
}

client.login(token);
